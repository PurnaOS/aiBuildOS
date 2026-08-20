import { realpathSync } from "node:fs";
import { relative, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";

/**
 * The project watcher (RQ-0026, DC-0022): chokidar over an open project's root, debounced into
 * one `project:changed` event, the revision counter's one ambient source.
 *
 * One watcher per project id, kept in `watchers`. Watching a project again replaces whatever was
 * watching it before — switching projects hands the watch over rather than doubling it — and
 * stopping is idempotent. Electron-vite's `externalizeDepsPlugin` leaves chokidar as a plain
 * `node_modules` dependency rather than bundling it, which is what lets it be a normal npm
 * package here (electron.vite.config.ts).
 */

const DEBOUNCE_MS = 300;

interface Entry {
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
  projectPath: string;
  onChange: () => void;
}

const watchers = new Map<string, Entry>();

/**
 * DC-0022's ignore list, tested against a path already relative to the project root:
 * `node_modules`, build output, and `.git` — except the three paths under `.git` that carry a
 * commit's own facts (`HEAD`, `index`, `refs/**`). Ignoring a *directory* stops chokidar
 * descending into it at all, which is why `.git` and `.git/refs` themselves have to stay
 * un-ignored — only their siblings (`objects`, `logs`, `config`, …) are.
 */
function isIgnored(relativePath: string): boolean {
  const posix = relativePath.split(sep).join("/");
  if (/(^|\/)(node_modules|out|dist)(\/|$)/.test(posix)) return true;
  if (posix === ".git" || posix.startsWith(".git/")) {
    return !/^\.git(\/(HEAD|index|refs(\/.*)?)?)?$/.test(posix);
  }
  return false;
}

function isUnderDocs(relativePath: string): boolean {
  const posix = relativePath.split(sep).join("/");
  return posix === "docs" || posix.startsWith("docs/");
}

/**
 * The record-read cache's generation, per project path (RQ-0026#AC-6): bumped when a changed path
 * is under `docs/`, and once more whenever a watch starts — a fresh watch is itself a reason a
 * cache built before it existed might be stale. Absent from this map (nothing has ever watched
 * that path) reads back as `-1` from `recordGeneration`, which `project:record` treats as "do not
 * cache at all" rather than as a generation that could ever compare equal again.
 */
const generations = new Map<string, number>();

function bumpGeneration(projectPath: string): void {
  generations.set(projectPath, (generations.get(projectPath) ?? 0) + 1);
}

export function watchProject(projectId: string, projectPath: string, onChange: () => void): void {
  stopWatching(projectId);

  // Paths arrive in two spellings: chokidar's crawl hands `ignored` the root as it was given,
  // while macOS fsevents reports events under the *real* path — `/private/var/...` for a project
  // opened as `/var/...`. Computing against whichever root actually contains the incoming path is
  // what keeps a temp-dir project's `docs/` writes reading as `docs/…` instead of `../../private/…`
  // in both layers. `generations` stays keyed by the path the caller gave, which is what
  // `project:record` asks by.
  let realRoot: string;
  try {
    realRoot = realpathSync(projectPath);
  } catch {
    realRoot = projectPath;
  }
  const roots = [...new Set([projectPath, realRoot])];
  const insidePath = (changed: string): string => {
    for (const root of roots) {
      const candidate = relative(root, changed);
      if (!candidate.startsWith("..")) return candidate;
    }
    return relative(projectPath, changed);
  };

  const watcher = chokidar.watch(projectPath, {
    ignoreInitial: true,
    // `awaitWriteFinish` stays off: the debounce below already absorbs a burst of writes to the
    // same file, which is the only thing it would add here.
    ignored: (path: string) => isIgnored(insidePath(path)),
  });

  const entry: Entry = { watcher, timer: null, projectPath, onChange };
  watchers.set(projectId, entry);

  // `FSWatcher` is an `EventEmitter`; an `error` with nobody listening throws, and an unreadable
  // subdirectory during the crawl is not worth losing the whole process over.
  watcher.on("error", () => {});

  watcher.on("all", (event, changedPath) => {
    // A directory appearing or disappearing is not a file changing — it is what keeping `.git` and
    // `.git/refs` un-ignored for traversal costs: the first commit in a fresh repository creates
    // `.git/refs/heads` as a bare directory before it ever writes the ref file inside it, and that
    // creation is not itself a fact anything downstream cares about.
    if (event !== "add" && event !== "change" && event !== "unlink") return;

    if (isUnderDocs(insidePath(changedPath))) bumpGeneration(projectPath);

    // Collected into one `onChange` per burst: reset the clock on every event, fire once ~300ms
    // after the last one lands.
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      onChange();
    }, DEBOUNCE_MS);
  });

  bumpGeneration(projectPath);
}

export function stopWatching(projectId: string): void {
  const entry = watchers.get(projectId);
  if (!entry) return;
  watchers.delete(projectId);
  if (entry.timer) clearTimeout(entry.timer);
  // Fire-and-forget: nothing here is waiting for the underlying handles to finish closing, and a
  // project can be reopened (and rewatched) long before they would.
  void entry.watcher.close();
}

export function stopAllWatching(): void {
  for (const projectId of [...watchers.keys()]) stopWatching(projectId);
}

/**
 * A write main just made itself (RQ-0026): the generation moves and the changed event fires
 * without waiting on the filesystem watcher at all. fsevents on macOS can coalesce a rapid burst
 * of rewrites to one file and drop the tail — rarely, but a state flip the interface depends on
 * cannot be "rarely". The watcher stays the source for every write main did not make.
 */
export function noteSelfWrite(projectPath: string): void {
  bumpGeneration(projectPath);
  for (const entry of watchers.values()) {
    if (entry.projectPath !== projectPath) continue;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      entry.onChange();
    }, DEBOUNCE_MS);
  }
}

/**
 * The record-read cache seam (RQ-0026#AC-6): bumped by this module whenever `docs/` changes, so
 * `project:record` can answer from cache between changes. `-1` — nothing has ever watched this
 * path, e.g. a unit test that calls handlers without going through `project:open` — means "no
 * cache", not "stale forever".
 */
export function recordGeneration(projectPath: string): number {
  return generations.get(projectPath) ?? -1;
}

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import {
  changes,
  commitAll,
  deleteBranch,
  GitError,
  git,
  lastCommitDate,
  mergeAbort,
  mergeBranch,
  revListCount,
  status,
  worktreeAdd,
  worktreeList,
  worktreePrune,
  worktreeRemove,
} from "./git.js";
import { type Harness, loadHarnesses } from "./harnesses.js";
import { loadProjects } from "./projects.js";
import { applyArtifactEdit } from "./record.js";
import { BUSY_CAP, type SessionRegistry, type SessionRow } from "./sessions.js";

/**
 * Worktree builds (RQ-0020, RQ-0021), exactly as DC-0021 settles them: the branch is the binding,
 * main owns every process state, checkpoints ride the branch, the merge is the person's accept.
 *
 * A worktree is never located by reconstructing a path from a naming convention — `worktreeList`
 * (git.ts) is the enumeration, exactly as DC-0021 says: "no tracked file records a session id". This
 * module only ever invents a path for a worktree that does not exist yet: `startBuild`'s own story
 * worktree, and `startSprint`'s sprint worktree (RQ-0035, DC-0025) — the sprint itself follows the
 * same rule, its branch and worktree are its whole record, no tracked file either.
 */

export interface BuildRow {
  readonly storyId: string;
  readonly branch: string;
  readonly sessionId: string | null;
  readonly dirty: boolean;
  /** Where the worktree lives on disk (RQ-0037). */
  readonly path: string;
  /** The sprint this build belongs to, parsed from the branch name; `null` outside one (RQ-0035). */
  readonly sprintId: string | null;
  /** Checkpoints on the branch since its base (RQ-0037). */
  readonly ahead: number;
  /** ISO date of the newest commit on the branch; `null` on an unborn branch (RQ-0037). */
  readonly lastCheckpointAt: string | null;
}

/** One sprint worktree, classified out of the same enumeration (RQ-0035). */
export interface SprintRow {
  readonly sprintId: string;
  readonly branch: string;
  readonly path: string;
  readonly dirty: boolean;
  readonly stories: number;
}

const BRANCH_PREFIX = "aibuildos/";

/** `aibuildos/<sprint>--<story>` inside a sprint, `aibuildos/<story>` outside one — the `--` binding
 * DC-0025 settles: unambiguous because an ID can never itself contain a doubled hyphen. */
function branchFor(storyId: string, sprintId?: string | null): string {
  return sprintId
    ? `${BRANCH_PREFIX}${sprintId.toLowerCase()}--${storyId.toLowerCase()}`
    : `${BRANCH_PREFIX}${storyId.toLowerCase()}`;
}

function sprintBranchFor(sprintId: string): string {
  return `${BRANCH_PREFIX}${sprintId.toLowerCase()}`;
}

/**
 * Where new worktrees are created: `<userData>/worktrees/<projectId>/<storyId-or-SPRINT-ID>`
 * (DC-0021), overridable by an environment variable for the same reason `ipc.ts` overrides
 * `harnesses.json`/`projects.json` — so this module, and its tests, never have to touch a real
 * Electron `userData` directory.
 */
function worktreesRoot(): string {
  return process.env.AIBUILDOS_WORKTREES_ROOT ?? join(app.getPath("userData"), "worktrees");
}

/** Same override as every other store this module reads, so a unit test never has to touch a real
 * Electron `userData` directory just to resolve a project or a harness by id. */
function projectFile(): string {
  return process.env.AIBUILDOS_PROJECTS_FILE ?? join(app.getPath("userData"), "projects.json");
}
function harnessFile(): string {
  return process.env.AIBUILDOS_HARNESSES_FILE ?? join(app.getPath("userData"), "harnesses.json");
}

function messageOf(cause: unknown): string {
  if (cause instanceof GitError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The project's id, for namespacing a **new** sprint worktree the same way `startBuild` namespaces a
 * story one — `startSprint` is only ever handed `projectPath` (ipc.ts's own `sprint:start` handler
 * resolves no further), so the id is recovered by the same path→project relationship the registry
 * itself is keyed on. Falls back to a stable hash of the path when no registry answers (a unit test
 * with no `projects.json` in the picture) — never a crash, just a less readable directory name.
 */
function resolveProjectId(projectPath: string): string {
  try {
    const match = loadProjects(projectFile()).find((candidate) => candidate.path === projectPath);
    if (match) return match.id;
  } catch {
    // `projectFile()` falls back to `app.getPath`, which only exists inside a running Electron
    // process — a unit test with no `AIBUILDOS_PROJECTS_FILE` and no Electron runtime falls
    // straight through to the hash below, exactly like an unregistered path does.
  }
  return createHash("sha1").update(projectPath).digest("hex").slice(0, 12);
}

/** One worktree this module actually created, classified from the branch alone (DC-0025's `--`
 * binding) — no tracked file, exactly as DC-0021 and DC-0025 both promise. */
type Classified =
  | { readonly kind: "story"; readonly storyId: string; readonly sprintId: string | null }
  | { readonly kind: "sprint"; readonly sprintId: string };

function classify(branch: string): Classified | null {
  if (!branch.startsWith(BRANCH_PREFIX)) return null;
  const rest = branch.slice(BRANCH_PREFIX.length);
  const cut = rest.indexOf("--");
  if (cut === -1) {
    // No `--`: either the sprint's own branch, or a plain story build outside one.
    return rest.toLowerCase().startsWith("sp-")
      ? { kind: "sprint", sprintId: rest.toUpperCase() }
      : { kind: "story", storyId: rest.toUpperCase(), sprintId: null };
  }
  return {
    kind: "story",
    sprintId: rest.slice(0, cut).toUpperCase(),
    storyId: rest.slice(cut + 2).toUpperCase(),
  };
}

/** The worktree this story is building in, found by asking Git rather than by guessing a path —
 * matches either branch form (DC-0025): a plain `aibuildos/<story>` or a sprint-scoped
 * `aibuildos/<sprint>--<story>`. */
async function locate(
  projectPath: string,
  storyId: string,
): Promise<{ path: string; branch: string; sprintId: string | null } | null> {
  const upper = storyId.toUpperCase();
  for (const worktree of await worktreeList(projectPath)) {
    if (worktree.branch === null) continue;
    const info = classify(worktree.branch);
    if (info && info.kind === "story" && info.storyId === upper) {
      return { path: worktree.path, branch: worktree.branch, sprintId: info.sprintId };
    }
  }
  return null;
}

/**
 * The checkout a build's branch is based on: the sprint's own worktree when the build belongs to
 * one — merges must land on a branch some checkout has out (DC-0025) — main's own checkout
 * otherwise. Falls back to `projectPath` if the sprint worktree cannot be found; the `stories_live`
 * guard means a sprint cannot be torn down while one of its story worktrees still exists, so this is
 * a safety net, not a path this module expects to take.
 */
async function basePathFor(projectPath: string, sprintId: string | null): Promise<string> {
  if (!sprintId) return projectPath;
  const branch = sprintBranchFor(sprintId);
  const found = (await worktreeList(projectPath)).find((worktree) => worktree.branch === branch);
  return found ? found.path : projectPath;
}

/**
 * The sessionId↔story binding a build starts with, and the one thing this module remembers that Git
 * cannot answer: which live session, if any, is sitting in a given worktree, so `mergeBuild` and
 * `discardBuild` — whose signatures carry no `SessionRegistry` — can still close it before the
 * worktree it is running in disappears from under it.
 *
 * Keyed by `<projectPath>::<STORY-ID>`, matching every other function in this module: only
 * `startBuild` is handed a project id, everything else is handed a project path.
 */
interface Live {
  readonly close: () => Promise<void>;
}
const live = new Map<string, Live>();
const key = (projectPath: string, storyId: string): string =>
  `${projectPath}::${storyId.toUpperCase()}`;

/**
 * Commit a dirty worktree on its own branch, or do nothing to a clean one. Exported on its own so
 * TC-0066 can drive it directly against a real repository, a rejecting hook included, without a live
 * agent session anywhere in the picture.
 */
export async function checkpointWorktree(
  worktreePath: string,
  message: string,
): Promise<{ ok: true; committed: boolean } | { ok: false; message: string }> {
  try {
    const tree = await status(worktreePath);
    if (tree.changed === 0) return { ok: true, committed: false };
    await commitAll(worktreePath, message);
    return { ok: true, committed: true };
  } catch (cause) {
    return { ok: false, message: messageOf(cause) };
  }
}

/**
 * `building → review`, in the build's own project (BG-0007, ST-0041) — through `applyArtifactEdit`,
 * the same guarded core `project:artifact-save` calls, so a build's own flip is refused exactly as a
 * person's save would be. No prior read: the cheapest honest check is attempting the edit itself and
 * reading what comes back.
 *
 * A refusal is not automatically a failure. `applyArtifactEdit` refuses a state change in exactly two
 * ways — the story is not in the bundle at all, or the transition is not declared — and only the
 * latter is expected here: a story already sent onward (accepted, sent back to `building` again) by
 * the time its turn ends is a story this flip has nothing to do, not an error. Anything else —
 * not-found included — is real and gets said, in the session's own stream (`aibuildos.flip`), the
 * same place a checkpoint's own rejection already lands.
 */
function flipToReview(
  sessions: SessionRegistry,
  sessionId: string,
  projectPath: string,
  storyId: string,
): void {
  let result: ReturnType<typeof applyArtifactEdit>;
  try {
    result = applyArtifactEdit(projectPath, storyId, { state: "review" });
  } catch (cause) {
    sessions.noteCustom(sessionId, "aibuildos.flip", { ok: false, message: messageOf(cause) });
    return;
  }
  if (result.problem === null) return;
  if (result.problem.includes("has no transition from")) return;
  sessions.noteCustom(sessionId, "aibuildos.flip", { ok: false, message: result.problem });
}

/**
 * Attach a fresh session to a worktree that already exists — session start, the onTurnEnd
 * checkpoint→flip, `live.set` — the one path `startBuild` (a brand-new worktree) and `resumeBuild`
 * (a surviving one, ST-0054) both end in. Neither prompts: starting the first turn is the caller's
 * job, exactly as it always was for a fresh build.
 */
async function attach(
  sessions: SessionRegistry,
  project: { id: string; path: string },
  storyId: string,
  worktreePath: string,
  harness: Harness,
): Promise<{ ok: true; sessionId: string } | { ok: false; code: string; message: string }> {
  const started = await sessions.start(
    harness,
    project.id,
    worktreePath,
    app.getVersion(),
    storyId,
  );
  if (!started.ok) return { ok: false, code: started.code, message: started.message };

  let turn = 0;
  sessions.onTurnEnd(started.sessionId, () => {
    turn += 1;
    // Checkpoint first, then the flip: the checkpoint captures this turn's work on the worktree's own
    // branch, the flip is main's own write in the main checkout (DC-0021) — two different trees, but
    // one order, so a flip never announces "ready for review" ahead of the work it is reviewing.
    void checkpointWorktree(worktreePath, `checkpoint: ${storyId} turn ${turn}`)
      .then((result) => {
        if (!result.ok) {
          sessions.noteCustom(started.sessionId, "aibuildos.checkpoint", {
            ok: false,
            message: result.message,
          });
        }
      })
      .then(() => flipToReview(sessions, started.sessionId, project.path, storyId));
  });

  live.set(key(project.path, storyId), { close: () => sessions.close(started.sessionId) });
  return { ok: true, sessionId: started.sessionId };
}

export async function startBuild(
  sessions: SessionRegistry,
  project: { id: string; path: string },
  storyId: string,
  harness: Harness,
  /** Build inside a sprint (RQ-0035, DC-0025): base = the sprint branch, so the story branches
   * from it rather than from main's `HEAD`; `null`/absent is a plain build. */
  sprintId?: string | null,
): Promise<{ ok: true; sessionId: string } | { ok: false; code: string; message: string }> {
  // A ceiling raised deliberately, per RQ-0021's own consequence — the registry is the source of
  // truth for what is actually live, not this module's own bookkeeping (which can outlive a session
  // that crashed without going through `close()`).
  if (sessions.busyCount() >= BUSY_CAP) {
    return {
      ok: false,
      code: "build_cap",
      message: `${BUSY_CAP} builds are already running — the cap is ${BUSY_CAP} at once.`,
    };
  }

  let base = "HEAD";
  if (sprintId) {
    const sprintBranch = sprintBranchFor(sprintId);
    const hasSprint = (await worktreeList(project.path)).some(
      (worktree) => worktree.branch === sprintBranch,
    );
    if (!hasSprint) {
      return {
        ok: false,
        code: "no_sprint",
        message: `${sprintId} has no worktree to build against.`,
      };
    }
    base = sprintBranch;
  }

  const branch = branchFor(storyId, sprintId);
  const worktreePath = join(worktreesRoot(), project.id, storyId);

  try {
    mkdirSync(join(worktreesRoot(), project.id), { recursive: true });
    await worktreeAdd(project.path, worktreePath, branch, base);
  } catch (cause) {
    return {
      ok: false,
      code: cause instanceof GitError ? cause.code : "failed",
      message: messageOf(cause),
    };
  }

  const started = await attach(sessions, project, storyId, worktreePath, harness);
  if (!started.ok) {
    // Nothing to build with: leave nothing behind either. Force delete — a branch this fresh has
    // never merged anywhere, so the ordinary merged-ness check `deleteBranch` otherwise applies
    // would only get in the way.
    await worktreeRemove(project.path, worktreePath, true).catch(() => undefined);
    await deleteBranch(project.path, branch, true).catch(() => undefined);
  }
  return started;
}

/**
 * Re-attach a fresh session to a worktree that survived a restart (RQ-0036, ST-0054) — located by
 * branch alone, both name forms, exactly as `locate` already does for review and merge. Refuses
 * `not_found` (no such project, harness, or worktree), `already_attached` (the registry — the
 * source of truth for what is actually live — already holds a session for this story in this
 * project), or the shared `build_cap`.
 */
export async function resumeBuild(
  sessions: SessionRegistry,
  projectId: string,
  storyId: string,
  harnessId: string,
): Promise<{ ok: true; sessionId: string } | { ok: false; code: string; message: string }> {
  const project = loadProjects(projectFile()).find((candidate) => candidate.id === projectId);
  if (!project) {
    return { ok: false, code: "not_found", message: `No project with id ${projectId}.` };
  }

  const harness = loadHarnesses(harnessFile()).find((candidate) => candidate.id === harnessId);
  if (!harness) {
    return { ok: false, code: "not_found", message: "That harness is no longer configured." };
  }

  const worktree = await locate(project.path, storyId).catch(() => null);
  if (!worktree) {
    return { ok: false, code: "not_found", message: `No worktree build for ${storyId}.` };
  }

  const attached = sessions
    .list()
    .some(
      (row) => row.projectId === project.id && row.storyId?.toUpperCase() === storyId.toUpperCase(),
    );
  if (attached) {
    return {
      ok: false,
      code: "already_attached",
      message: `A session is already attached to ${storyId}.`,
    };
  }

  if (sessions.busyCount() >= BUSY_CAP) {
    return {
      ok: false,
      code: "build_cap",
      message: `${BUSY_CAP} builds are already running — the cap is ${BUSY_CAP} at once.`,
    };
  }

  // review → building (ST-0054#AC-3): the same guarded flip a fresh build's caller performs for
  // ready→queued→building, done here because resume has no renderer walk ahead of it — nothing
  // prompts this session before it exists to attempt one. A story already at `building` (crashed
  // before its first turn ever ended) needs no transition at all; `applyArtifactEdit` only checks
  // one when the state is actually changing, so that case is already a no-op.
  applyArtifactEdit(project.path, storyId, { state: "building" });

  return await attach(sessions, project, storyId, worktree.path, harness);
}

export async function listBuilds(
  sessions: SessionRegistry,
  projectPath: string,
): Promise<{ builds: BuildRow[]; sprints: SprintRow[]; problem: string | null }> {
  try {
    // "On build:list: worktree prune first, then enumerate" (DC-0021) — a worktree deleted by hand
    // must not go on being reported as though it were still there.
    await worktreePrune(projectPath);

    const classified = (await worktreeList(projectPath))
      .filter((worktree): worktree is { path: string; branch: string } => worktree.branch !== null)
      .map((worktree) => ({ worktree, info: classify(worktree.branch) }))
      .filter(
        (entry): entry is { worktree: { path: string; branch: string }; info: Classified } =>
          entry.info !== null,
      );

    const sessionByStory = new Map(
      sessions
        .list()
        .filter((row): row is SessionRow & { storyId: string } => row.storyId !== null)
        .map((row) => [row.storyId.toUpperCase(), row.sessionId]),
    );
    const sprintWorktrees = classified.filter(
      (
        entry,
      ): entry is {
        worktree: { path: string; branch: string };
        info: { kind: "sprint"; sprintId: string };
      } => entry.info.kind === "sprint",
    );

    const builds = await Promise.all(
      classified
        .filter(
          (
            entry,
          ): entry is {
            worktree: { path: string; branch: string };
            info: { kind: "story"; storyId: string; sprintId: string | null };
          } => entry.info.kind === "story",
        )
        .map(async ({ worktree, info }) => {
          const tree = await status(worktree.path).catch(() => null);
          const basePath = await basePathFor(projectPath, info.sprintId);
          let ahead = 0;
          try {
            const base = await reviewBase(basePath, worktree.path);
            ahead = await revListCount(worktree.path, `${base}..HEAD`);
          } catch {
            ahead = 0;
          }
          return {
            storyId: info.storyId,
            branch: worktree.branch,
            sessionId: sessionByStory.get(info.storyId) ?? null,
            dirty: tree === null ? false : tree.changed > 0,
            path: worktree.path,
            sprintId: info.sprintId,
            ahead,
            lastCheckpointAt: await lastCommitDate(worktree.path, "HEAD"),
          };
        }),
    );

    const sprints = await Promise.all(
      sprintWorktrees.map(async ({ worktree, info }) => {
        const tree = await status(worktree.path).catch(() => null);
        return {
          sprintId: info.sprintId,
          branch: worktree.branch,
          path: worktree.path,
          dirty: tree === null ? false : tree.changed > 0,
          stories: builds.filter((build) => build.sprintId === info.sprintId).length,
        };
      }),
    );

    return { builds, sprints, problem: null };
  } catch (cause) {
    return { builds: [], sprints: [], problem: messageOf(cause) };
  }
}

/**
 * The branch's changes against its base (RQ-0020#AC-4): everything different between the base
 * checkout's history and the worktree's current files, committed checkpoints and the in-flight
 * turn's uncommitted edits alike. Diffed from the branch's **merge-base** with the base rather than
 * the base's current `HEAD` — once a second build's accept has moved it, diffing straight against
 * its new `HEAD` would show that merge's own changes as noise on every other build's review
 * (ST-0038's parallel builds). `baseDir` is main's own checkout for a plain build, or the sprint's
 * own worktree for one built inside a sprint (DC-0025) — `basePathFor` resolves which.
 */
async function reviewBase(baseDir: string, worktreePath: string): Promise<string> {
  const baseHead = (await git(baseDir, "rev-parse", "HEAD")).trim();
  return (await git(worktreePath, "merge-base", "HEAD", baseHead)).trim();
}

export async function buildChanges(
  projectPath: string,
  storyId: string,
): Promise<{ changes: { path: string }[]; problem: string | null }> {
  const worktree = await locate(projectPath, storyId).catch(() => null);
  if (!worktree) return { changes: [], problem: `No worktree build for ${storyId}.` };

  try {
    const basePath = await basePathFor(projectPath, worktree.sprintId);
    const base = await reviewBase(basePath, worktree.path);
    const tracked = (await git(worktree.path, "diff", "--name-only", base))
      .split("\n")
      .filter((path) => path !== "");
    const { entries } = await changes(worktree.path);
    const untracked = entries.filter((entry) => entry.untracked).map((entry) => entry.path);
    const paths = [...new Set([...tracked, ...untracked])].sort();
    return { changes: paths.map((path) => ({ path })), problem: null };
  } catch (cause) {
    return { changes: [], problem: messageOf(cause) };
  }
}

export async function buildDiff(
  projectPath: string,
  storyId: string,
  path: string,
): Promise<{ path: string; oldText: string | null; newText: string; problem: string | null }> {
  const worktree = await locate(projectPath, storyId).catch(() => null);
  if (!worktree)
    return { path, oldText: null, newText: "", problem: `No worktree build for ${storyId}.` };

  let oldText: string | null = null;
  try {
    const basePath = await basePathFor(projectPath, worktree.sprintId);
    const base = await reviewBase(basePath, worktree.path);
    oldText = await git(worktree.path, "show", `${base}:${path}`);
  } catch {
    oldText = null;
  }

  let newText = "";
  try {
    newText = readFileSync(join(worktree.path, path), "utf8");
  } catch (cause) {
    if (oldText === null) return { path, oldText: null, newText: "", problem: messageOf(cause) };
  }

  return { path, oldText, newText, problem: null };
}

/** Closes this story's live session, if any, and forgets the binding — called once a worktree is
 * about to stop existing, so nothing keeps prompting an agent whose cwd just disappeared. */
async function forget(projectPath: string, storyId: string): Promise<void> {
  const entryKey = key(projectPath, storyId);
  const entry = live.get(entryKey);
  if (!entry) return;
  live.delete(entryKey);
  await entry.close().catch(() => undefined);
}

export async function mergeBuild(
  projectPath: string,
  storyId: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const worktree = await locate(projectPath, storyId).catch(() => null);
  if (!worktree)
    return { ok: false, code: "not_found", message: `No worktree build for ${storyId}.` };

  // A plain build's base is main's own checkout; a sprint story's is the sprint's own worktree —
  // merging into an un-checked-out branch is impossible, so the sprint worktree is where its
  // stories' accepts land (DC-0025), not main.
  const basePath = await basePathFor(projectPath, worktree.sprintId);

  try {
    await mergeBranch(basePath, worktree.branch, `${storyId}: accept the build`);
  } catch (cause) {
    // Left for a person, in Git's own words — the base is put back exactly as it was.
    await mergeAbort(basePath).catch(() => undefined);
    return { ok: false, code: "conflict", message: messageOf(cause) };
  }

  // The merge landed. Close the session before the directory it is sitting in disappears.
  await forget(projectPath, storyId);

  try {
    // `worktree remove` is an administrative command against the whole repo — it runs fine from
    // `projectPath` regardless of which checkout the branch merged into. Branch deletion is not:
    // `-d` only succeeds where it can see the branch as merged, which is `basePath`'s `HEAD` now
    // that the merge landed there, not necessarily main's.
    await worktreeRemove(projectPath, worktree.path);
    await deleteBranch(basePath, worktree.branch);
  } catch (cause) {
    return { ok: false, code: "cleanup_failed", message: messageOf(cause) };
  }

  return { ok: true };
}

export async function discardBuild(
  projectPath: string,
  storyId: string,
): Promise<{ problem: string | null }> {
  const worktree = await locate(projectPath, storyId).catch(() => null);
  if (!worktree) return { problem: `No worktree build for ${storyId}.` };

  await forget(projectPath, storyId);

  try {
    await worktreeRemove(projectPath, worktree.path, true);
    await deleteBranch(projectPath, worktree.branch, true);
  } catch (cause) {
    return { problem: messageOf(cause) };
  }

  return { problem: null };
}

/**
 * Every `sp-<id>--*` worktree still live for a sprint — both `mergeSprint` and `discardSprint`
 * refuse while this is non-empty (DC-0025's `stories_live` guard): a sprint cannot be closed out
 * from under a build.
 */
function liveSprintStories(
  worktrees: readonly { branch: string | null }[],
  branch: string,
): boolean {
  const prefix = `${branch}--`;
  return worktrees.some((worktree) => worktree.branch?.startsWith(prefix) === true);
}

/**
 * The git side of starting a sprint (RQ-0035, DC-0025): the record's `Sprint` artifact is the
 * renderer's business through the ordinary guarded save (`sprint:start`'s own contract comment) —
 * this mints only the branch `aibuildos/<sprint>` from `projectPath`'s `HEAD` and the worktree
 * checked out on it, because merging into a branch nothing has checked out is impossible.
 */
export async function startSprint(
  projectPath: string,
  sprintId: string,
): Promise<{ ok: true; branch: string } | { ok: false; code: string; message: string }> {
  const branch = sprintBranchFor(sprintId);

  const branchExists = (await git(projectPath, "branch", "--list", branch)).trim() !== "";
  if (branchExists) {
    return { ok: false, code: "sprint_exists", message: `${sprintId} already has a branch.` };
  }

  const projectId = resolveProjectId(projectPath);
  const worktreePath = join(worktreesRoot(), projectId, sprintId.toUpperCase());

  try {
    mkdirSync(join(worktreesRoot(), projectId), { recursive: true });
    await worktreeAdd(projectPath, worktreePath, branch);
  } catch (cause) {
    return {
      ok: false,
      code: cause instanceof GitError ? cause.code : "failed",
      message: messageOf(cause),
    };
  }

  return { ok: true, branch };
}

export async function mergeSprint(
  projectPath: string,
  sprintId: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const branch = sprintBranchFor(sprintId);
  const worktrees = await worktreeList(projectPath);
  const sprintWorktree = worktrees.find((worktree) => worktree.branch === branch);
  if (!sprintWorktree) {
    return { ok: false, code: "not_found", message: `No worktree for ${sprintId}.` };
  }
  if (liveSprintStories(worktrees, branch)) {
    return { ok: false, code: "stories_live", message: `${sprintId} still has stories building.` };
  }

  try {
    await mergeBranch(projectPath, branch, `${sprintId}: finish the sprint`);
  } catch (cause) {
    // Left for a person, in Git's own words — main is put back exactly as it was.
    await mergeAbort(projectPath).catch(() => undefined);
    return { ok: false, code: "conflict", message: messageOf(cause) };
  }

  try {
    await worktreeRemove(projectPath, sprintWorktree.path);
    await deleteBranch(projectPath, branch);
  } catch (cause) {
    return { ok: false, code: "cleanup_failed", message: messageOf(cause) };
  }

  return { ok: true };
}

export async function discardSprint(
  projectPath: string,
  sprintId: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const branch = sprintBranchFor(sprintId);
  const worktrees = await worktreeList(projectPath);
  const sprintWorktree = worktrees.find((worktree) => worktree.branch === branch);
  if (!sprintWorktree) {
    return { ok: false, code: "not_found", message: `No worktree for ${sprintId}.` };
  }
  if (liveSprintStories(worktrees, branch)) {
    return { ok: false, code: "stories_live", message: `${sprintId} still has stories building.` };
  }

  try {
    await worktreeRemove(projectPath, sprintWorktree.path, true);
    await deleteBranch(projectPath, branch, true);
  } catch (cause) {
    return { ok: false, code: "cleanup_failed", message: messageOf(cause) };
  }

  return { ok: true };
}

export function listSessions(sessions: SessionRegistry): SessionRow[] {
  return sessions.list();
}

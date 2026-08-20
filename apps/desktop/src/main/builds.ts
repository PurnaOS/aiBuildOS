import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import {
  changes,
  commitAll,
  deleteBranch,
  GitError,
  git,
  mergeAbort,
  mergeBranch,
  status,
  worktreeAdd,
  worktreeList,
  worktreePrune,
  worktreeRemove,
} from "./git.js";
import { applyArtifactEdit } from "./record.js";
import type { SessionRegistry, SessionRow } from "./sessions.js";

/**
 * Worktree builds (RQ-0020, RQ-0021), exactly as DC-0021 settles them: the branch is the binding,
 * main owns every process state, checkpoints ride the branch, the merge is the person's accept.
 *
 * A worktree is never located by reconstructing a path from a naming convention — `worktreeList`
 * (git.ts) is the enumeration, exactly as DC-0021 says: "no tracked file records a session id". The
 * only place this module invents a path is `startBuild`, for a worktree that does not exist yet.
 */

export interface BuildRow {
  readonly storyId: string;
  readonly branch: string;
  readonly sessionId: string | null;
  readonly dirty: boolean;
}

const BRANCH_PREFIX = "aibuildos/";
/** RQ-0021's consequence #2: a ceiling to raise deliberately, not a limit discovered under load. */
const CONCURRENCY_CAP = 3;

function branchFor(storyId: string): string {
  return `${BRANCH_PREFIX}${storyId.toLowerCase()}`;
}

/**
 * Where new worktrees are created: `<userData>/worktrees/<projectId>/<storyId>` (DC-0021), overridable
 * by an environment variable for the same reason `ipc.ts` overrides `harnesses.json`/`projects.json`
 * — so this module, and its tests, never have to touch a real Electron `userData` directory.
 */
function worktreesRoot(): string {
  return process.env.AIBUILDOS_WORKTREES_ROOT ?? join(app.getPath("userData"), "worktrees");
}

function messageOf(cause: unknown): string {
  if (cause instanceof GitError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

/** The worktree this story is building in, found by asking Git rather than by guessing a path. */
async function locate(
  projectPath: string,
  storyId: string,
): Promise<{ path: string; branch: string } | null> {
  const branch = branchFor(storyId);
  const found = (await worktreeList(projectPath)).find((worktree) => worktree.branch === branch);
  return found ? { path: found.path, branch } : null;
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

export async function startBuild(
  sessions: SessionRegistry,
  project: { id: string; path: string },
  storyId: string,
  harness: { id: string; displayName: string; command: string; args: string[] },
): Promise<{ ok: true; sessionId: string } | { ok: false; code: string; message: string }> {
  // A ceiling raised deliberately, per RQ-0021's own consequence — the registry is the source of
  // truth for what is actually live, not this module's own bookkeeping (which can outlive a session
  // that crashed without going through `close()`).
  const busy = sessions.list().filter((row) => row.storyId !== null).length;
  if (busy >= CONCURRENCY_CAP) {
    return {
      ok: false,
      code: "build_cap",
      message: `${CONCURRENCY_CAP} builds are already running — the cap is ${CONCURRENCY_CAP} at once.`,
    };
  }

  const branch = branchFor(storyId);
  const worktreePath = join(worktreesRoot(), project.id, storyId);

  try {
    mkdirSync(join(worktreesRoot(), project.id), { recursive: true });
    await worktreeAdd(project.path, worktreePath, branch);
  } catch (cause) {
    return {
      ok: false,
      code: cause instanceof GitError ? cause.code : "failed",
      message: messageOf(cause),
    };
  }

  const started = await sessions.start(
    harness,
    project.id,
    worktreePath,
    app.getVersion(),
    storyId,
  );
  if (!started.ok) {
    // Nothing to build with: leave nothing behind either.
    await worktreeRemove(project.path, worktreePath, true).catch(() => undefined);
    await deleteBranch(project.path, branch, true).catch(() => undefined);
    return { ok: false, code: started.code, message: started.message };
  }

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

export async function listBuilds(
  sessions: SessionRegistry,
  projectPath: string,
): Promise<{ builds: BuildRow[]; problem: string | null }> {
  try {
    // "On build:list: worktree prune first, then enumerate" (DC-0021) — a worktree deleted by hand
    // must not go on being reported as though it were still there.
    await worktreePrune(projectPath);

    const worktrees = (await worktreeList(projectPath)).filter(
      (worktree): worktree is { path: string; branch: string } =>
        worktree.branch !== null && worktree.branch.startsWith(BRANCH_PREFIX),
    );
    const sessionByStory = new Map(
      sessions
        .list()
        .filter((row): row is SessionRow & { storyId: string } => row.storyId !== null)
        .map((row) => [row.storyId.toUpperCase(), row.sessionId]),
    );

    const builds = await Promise.all(
      worktrees.map(async (worktree) => {
        const storyId = worktree.branch.slice(BRANCH_PREFIX.length).toUpperCase();
        const tree = await status(worktree.path).catch(() => null);
        return {
          storyId,
          branch: worktree.branch,
          sessionId: sessionByStory.get(storyId) ?? null,
          dirty: tree === null ? false : tree.changed > 0,
        };
      }),
    );

    return { builds, problem: null };
  } catch (cause) {
    return { builds: [], problem: messageOf(cause) };
  }
}

/**
 * The branch's changes against main (RQ-0020#AC-4): everything different between main's history and
 * the worktree's current files, committed checkpoints and the in-flight turn's uncommitted edits
 * alike. Diffed from the branch's **merge-base** with main rather than main's current `HEAD` — once
 * a second build's accept has moved main, diffing straight against its new `HEAD` would show that
 * merge's own changes as noise on every other build's review (ST-0038's parallel builds).
 */
async function reviewBase(projectPath: string, worktreePath: string): Promise<string> {
  const mainHead = (await git(projectPath, "rev-parse", "HEAD")).trim();
  return (await git(worktreePath, "merge-base", "HEAD", mainHead)).trim();
}

export async function buildChanges(
  projectPath: string,
  storyId: string,
): Promise<{ changes: { path: string }[]; problem: string | null }> {
  const worktree = await locate(projectPath, storyId).catch(() => null);
  if (!worktree) return { changes: [], problem: `No worktree build for ${storyId}.` };

  try {
    const base = await reviewBase(projectPath, worktree.path);
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
    const base = await reviewBase(projectPath, worktree.path);
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

  try {
    await mergeBranch(projectPath, worktree.branch, `${storyId}: accept the build`);
  } catch (cause) {
    // Left for a person, in Git's own words — main is put back exactly as it was.
    await mergeAbort(projectPath).catch(() => undefined);
    return { ok: false, code: "conflict", message: messageOf(cause) };
  }

  // The merge landed on main. Close the session before the directory it is sitting in disappears.
  await forget(projectPath, storyId);

  try {
    await worktreeRemove(projectPath, worktree.path);
    await deleteBranch(projectPath, worktree.branch);
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

export function listSessions(sessions: SessionRegistry): SessionRow[] {
  return sessions.list();
}

import type { SessionRegistry } from "./sessions.js";

/**
 * Worktree builds (RQ-0020, RQ-0021), exactly as DC-0021 settles them: the branch is the binding,
 * main owns every process state, checkpoints ride the branch, the merge is the person's accept.
 *
 * Stubs until ST-0037/ST-0038 land — the channels and handlers exist so the lane building this
 * never edits the shared files.
 */

export interface BuildRow {
  readonly storyId: string;
  readonly branch: string;
  readonly sessionId: string | null;
  readonly dirty: boolean;
}

export interface SessionRow {
  readonly sessionId: string;
  readonly projectId: string;
  readonly storyId: string | null;
}

const NOT_BUILT = "Worktree builds are not built yet.";

export async function startBuild(
  _sessions: SessionRegistry,
  _project: { id: string; path: string },
  _storyId: string,
  _harness: { id: string; displayName: string; command: string; args: string[] },
): Promise<{ ok: true; sessionId: string } | { ok: false; code: string; message: string }> {
  return { ok: false, code: "not_built", message: NOT_BUILT };
}

export async function listBuilds(
  _sessions: SessionRegistry,
  _projectPath: string,
): Promise<{ builds: BuildRow[]; problem: string | null }> {
  return { builds: [], problem: null };
}

export async function buildChanges(
  _projectPath: string,
  _storyId: string,
): Promise<{ changes: { path: string }[]; problem: string | null }> {
  return { changes: [], problem: NOT_BUILT };
}

export async function buildDiff(
  _projectPath: string,
  _storyId: string,
  path: string,
): Promise<{ path: string; oldText: string | null; newText: string; problem: string | null }> {
  return { path, oldText: null, newText: "", problem: NOT_BUILT };
}

export async function mergeBuild(
  _projectPath: string,
  _storyId: string,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  return { ok: false, code: "not_built", message: NOT_BUILT };
}

export async function discardBuild(
  _projectPath: string,
  _storyId: string,
): Promise<{ problem: string | null }> {
  return { problem: NOT_BUILT };
}

export function listSessions(_sessions: SessionRegistry): SessionRow[] {
  return [];
}

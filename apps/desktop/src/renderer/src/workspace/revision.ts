import { createContext, useContext, useEffect, useState } from "react";

/**
 * How the rails know something has changed (ST-0015, DC-0022).
 *
 * A number that goes up whenever the project's files may have moved underneath what is on screen.
 * Rails put it in their effect's dependencies and re-read; nothing has to know which rail cares about
 * what, and nothing has to diff.
 *
 * The source is main's file watcher (RQ-0026): a `project:changed` event for the open project bumps
 * this, whatever wrote the files — the agent mid-turn, a terminal, another editor, Git itself. The
 * counter stays the mechanism; it is no longer also the thing deciding *when* to look. The user's own
 * saves still call `bump()` directly rather than waiting on the watcher's debounce (ST-0015#AC-3).
 *
 * The file tree reads a directory at a time, each in its own component, so this travels as context
 * rather than as a prop threaded down the recursion.
 */
export const RevisionContext = createContext(0);

/**
 * The setter's twin, for the few places that *cause* a change from deep in the tree — seeding
 * playbooks, for one — rather than merely reading. A no-op default keeps tests rendering without a
 * workspace around them.
 */
export const BumpContext = createContext<() => void>(() => undefined);

export function useRevision(): number {
  return useContext(RevisionContext);
}

export function useBump(): () => void {
  return useContext(BumpContext);
}

/**
 * The revision for a workspace: raised by the watcher's `project:changed` and by `bump` for the
 * user's own saves — plus whether a turn is in flight right now.
 *
 * `streaming` is tracked **here**, not in each editor, because the workspace outlives every tab. An
 * editor opened in the middle of a turn never saw the turn begin, and one that believed the agent was
 * idle would write over what the agent is in the middle of writing (RQ-0008#AC-3).
 */
export function useWorkspaceRevision(
  projectId: string,
  sessionId: string | null,
): {
  revision: number;
  bump: () => void;
  streaming: boolean;
} {
  const [revision, setRevision] = useState(0);
  const [streaming, setStreaming] = useState(false);
  const bump = (): void => setRevision((current) => current + 1);

  useEffect(() => {
    if (sessionId === null) {
      setStreaming(false);
      return;
    }

    return window.aibuildos.subscribe("session:event", (payload) => {
      if (payload.sessionId !== sessionId) return;
      const type = (payload.event as { type: string }).type;
      if (type === "RUN_STARTED") setStreaming(true);
      if (type === "RUN_FINISHED" || type === "RUN_ERROR") setStreaming(false);
    });
  }, [sessionId]);

  // The watcher's one signal (RQ-0026#AC-1, DC-0022): filtered to this workspace's own project, so
  // an event still in flight from the project just closed cannot bump the one that replaced it.
  useEffect(() => {
    return window.aibuildos.subscribe("project:changed", (payload) => {
      if (payload.projectId !== projectId) return;
      setRevision((current) => current + 1);
    });
  }, [projectId]);

  return { revision, bump, streaming };
}

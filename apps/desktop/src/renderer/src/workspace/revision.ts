import { createContext, useContext, useEffect, useState } from "react";

/**
 * How the rails know something has changed (ST-0015).
 *
 * A number that goes up whenever the project's files may have moved underneath what is on screen.
 * Rails put it in their effect's dependencies and re-read; nothing has to know which rail cares about
 * what, and nothing has to diff.
 *
 * The moment to bump it is the one the editors already use — a turn ending is when the agent has
 * stopped changing things — plus the user's own saves, because the record goes stale just as fast
 * when the writing is theirs.
 *
 * The file tree reads a directory at a time, each in its own component, so this travels as context
 * rather than as a prop threaded down the recursion.
 */
export const RevisionContext = createContext(0);

export function useRevision(): number {
  return useContext(RevisionContext);
}

/** The revision for a workspace: raised by the agent's turns, and by `bump` for the user's own. */
export function useWorkspaceRevision(sessionId: string | null): {
  revision: number;
  bump: () => void;
} {
  const [revision, setRevision] = useState(0);
  const bump = (): void => setRevision((current) => current + 1);

  useEffect(() => {
    if (sessionId === null) return;

    return window.aibuildos.subscribe("session:event", (payload) => {
      if (payload.sessionId !== sessionId) return;
      const type = (payload.event as { type: string }).type;
      if (type === "RUN_FINISHED" || type === "RUN_ERROR") setRevision((current) => current + 1);
    });
  }, [sessionId]);

  return { revision, bump };
}

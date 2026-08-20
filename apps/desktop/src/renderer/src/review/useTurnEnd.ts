import { useEffect } from "react";
import { turnEndWalk } from "./walk.js";

/**
 * Mounts the turn-end half of the build/review walk (RQ-0015#AC-3): when a turn finishes while any
 * story sits at `building`, flip it to `review`.
 *
 * Mounted once in `Workspace.tsx`, not in `WorkBoard.tsx` or `ReviewTab.tsx` — a tab can be closed
 * mid-turn, but the walk still has to land.
 *
 * No `bump` here any more (BG-0006, ST-0040): RQ-0026's file watcher is what every refresh rides on
 * now, and a flip is a write like any other — the watcher sees it and the rails re-read on their own.
 * What this hook alone can still tell the workspace is a **failure** nothing on disk will ever show:
 * a rejected read or save at turn's end used to vanish into `.catch(() => undefined)`, leaving the
 * story at `building` with no word said anywhere. `onProblem` is that word — Workspace.tsx holds it
 * and renders it, the one thing this hook cannot do sitting above any UI of its own.
 */
export function useTurnEnd(
  projectId: string,
  sessionId: string | null,
  onProblem: (text: string) => void,
): void {
  useEffect(() => {
    if (sessionId === null) return;

    return window.aibuildos.subscribe("session:event", (payload) => {
      if (payload.sessionId !== sessionId) return;
      const type = (payload.event as { type: string }).type;
      if (type !== "RUN_FINISHED" && type !== "RUN_ERROR") return;

      void Promise.all([
        window.aibuildos.invoke("project:record", { id: projectId }),
        window.aibuildos.invoke("build:list", { projectId }),
      ])
        .then(([record, builds]) =>
          // A worktree build's story flips when its own session's turn ends, in main (ST-0041);
          // the main conversation ending a turn must not flip a sibling still mid-build.
          turnEndWalk(
            (artifactId, frontmatter) =>
              window.aibuildos.invoke("project:artifact-save", {
                id: projectId,
                artifactId,
                frontmatter,
              }),
            record.artifacts ?? [],
            new Set(builds.builds.map((build) => build.storyId.toUpperCase())),
          ),
        )
        .catch((cause) => {
          onProblem(cause instanceof Error ? cause.message : String(cause));
        });
    });
  }, [projectId, sessionId, onProblem]);
}

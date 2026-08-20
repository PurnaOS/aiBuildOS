import { useEffect } from "react";
import { turnEndWalk } from "./walk.js";

/**
 * Mounts the turn-end half of the build/review walk (RQ-0015#AC-3): when a turn finishes while any
 * story sits at `building`, flip it to `review`.
 *
 * Mounted once in `Workspace.tsx`, not in `WorkBoard.tsx` or `ReviewTab.tsx` — a tab can be closed
 * mid-turn, but the walk still has to land. `bump` is taken as an argument rather than read with
 * `useBump()`: this hook is called from the workspace's own body, above the `BumpContext` provider
 * it renders, where that hook would answer with the no-op default.
 */
export function useTurnEnd(projectId: string, sessionId: string | null, bump: () => void): void {
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
        .then(async ([record, builds]) => {
          // A worktree build's story flips when its own session's turn ends (NowTab owns that);
          // the main conversation ending a turn must not flip a sibling still mid-build.
          const flipped = await turnEndWalk(
            (artifactId, frontmatter) =>
              window.aibuildos.invoke("project:artifact-save", {
                id: projectId,
                artifactId,
                frontmatter,
              }),
            record.artifacts ?? [],
            new Set(builds.builds.map((build) => build.storyId.toUpperCase())),
          );
          if (flipped.length > 0) bump();
        })
        .catch(() => undefined);
    });
  }, [projectId, sessionId, bump]);
}

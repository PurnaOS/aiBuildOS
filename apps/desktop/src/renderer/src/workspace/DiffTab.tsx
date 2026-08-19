import type { ChannelResponse } from "@aibuildos/ipc";
import { useEffect, useState } from "react";
import { mono } from "../ui.js";
import { Diff } from "./Diff.js";

/**
 * A changed file, as it was and as it is (ST-0012#AC-8).
 *
 * Read-only: editing is [RQ-0005](../../../../../docs/requirements/rq-0005.md). It draws with the
 * same component the transcript uses for a tool call's diff, so a change looks the same wherever it
 * is seen.
 */
type Result = ChannelResponse<"project:diff">;

export function DiffTab({
  projectId,
  path,
}: {
  projectId: string;
  path: string;
}): React.JSX.Element {
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    let live = true;
    void window.aibuildos
      .invoke("project:diff", { id: projectId, path })
      .then((next) => {
        if (live) setResult(next);
      })
      .catch((cause: unknown) => {
        if (live) {
          setResult({
            path,
            oldText: null,
            newText: "",
            problem: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
    return () => {
      live = false;
    };
  }, [projectId, path]);

  if (result === null) return <p className="p-6 text-sm text-neutral-500">Loading…</p>;
  if (result.problem) {
    return (
      <p data-testid="diff-problem" className="p-6 text-sm text-red-600">
        {result.problem}
      </p>
    );
  }

  return (
    <div data-testid="diff-tab" className="h-full overflow-auto p-4">
      {result.oldText === null && (
        <p className={`mb-2 text-xs text-neutral-500 ${mono}`}>new file</p>
      )}
      <Diff path={result.path} oldText={result.oldText ?? ""} newText={result.newText} />
    </div>
  );
}

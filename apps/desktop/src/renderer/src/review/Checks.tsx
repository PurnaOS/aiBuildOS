import type { ChannelResponse } from "@aibuildos/ipc";
import { useEffect, useRef, useState } from "react";
import { button, eyebrow, focusRing, mono } from "../ui.js";

type CheckResult = ChannelResponse<"check:run">["results"][number];
type RecordEntry = NonNullable<ChannelResponse<"project:record">["artifacts"]>[number];

const OUTCOME_WORD: Record<CheckResult["outcome"], string> = {
  passed: "passed",
  failed: "failed",
  could_not_run: "could not run",
};

const OUTCOME_COLOR: Record<CheckResult["outcome"], string> = {
  passed: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600",
  could_not_run: "text-amber-600 dark:text-amber-500",
};

/** True once a body's own text names it a checks playbook — the same fence `checks.ts` looks for,
 * duplicated rather than shared because main and the renderer are different processes reading the
 * same convention, not the same code. */
function hasCheckFence(body: string): boolean {
  return body.split("\n").some((line) => line === "```check");
}

/**
 * Whether this project declares any checks at all, read the way `PlaybookStrip` reads its buttons:
 * every active `Playbook`, its body fetched, its fences looked at (RQ-0019#AC-1 — "the workspace
 * lists them from the record alone, and a project declaring none offers nothing"). Checked once per
 * mount rather than on every `revision` bump: a project's checks playbook changing while a review tab
 * is already open is not a case any acceptance criterion asks for.
 */
async function projectHasChecks(projectId: string): Promise<boolean> {
  const record = await window.aibuildos
    .invoke("project:record", { id: projectId })
    .catch(() => ({ artifacts: null as RecordEntry[] | null }));
  const playbooks = (record.artifacts ?? []).filter(
    (artifact) => artifact.type === "Playbook" && artifact.state === "active",
  );
  for (const playbook of playbooks) {
    const artifact = await window.aibuildos
      .invoke("project:artifact", { id: projectId, artifactId: playbook.id })
      .catch(() => null);
    if (artifact !== null && hasCheckFence(artifact.body)) return true;
  }
  return false;
}

/**
 * The checks section of a story's review (RQ-0019, ST-0033#AC-3): a button that runs the project's
 * own gate, live output as it streams, and each command's verdict in words once `check:run` resolves
 * — the evidence AC-4 wants standing beside the story rather than review taking the code's word for
 * it.
 *
 * `check:run` resolves once, with every result; the live transcript arrives separately over
 * `check:output`, keyed by which command it belongs to since two commands can share output that
 * arrives interleaved only in that main runs them one at a time, never in the same chunk.
 */
export function Checks({
  projectId,
  onPrompt,
}: {
  projectId: string;
  onPrompt: (text: string) => void;
}): React.JSX.Element | null {
  const [offered, setOffered] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [output, setOutput] = useState<{ command: string; chunk: string }[]>([]);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void projectHasChecks(projectId).then((has) => {
      if (live) setOffered(has);
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  useEffect(() => {
    return window.aibuildos.subscribe("check:output", (payload) => {
      if (payload.projectId !== projectId) return;
      setOutput((current) => [...current, { command: payload.command, chunk: payload.chunk }]);
    });
  }, [projectId]);

  // `output` is a trigger, not read: each chunk that arrives is what should push the scroll down.
  // biome-ignore lint/correctness/useExhaustiveDependencies: output is a trigger
  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [output]);

  const run = async (): Promise<void> => {
    setRunning(true);
    setResults(null);
    setProblem(null);
    setOutput([]);
    try {
      const result = await window.aibuildos.invoke("check:run", { id: projectId });
      setResults(result.results);
      setProblem(result.problem);
    } finally {
      setRunning(false);
    }
  };

  const hand = (failing: CheckResult[]): void => {
    const text = failing
      .map((result) => {
        const transcript = output
          .filter((line) => line.command === result.command)
          .map((line) => line.chunk)
          .join("");
        return `\`${result.command}\` ${OUTCOME_WORD[result.outcome]}:\n\n${transcript}`;
      })
      .join("\n\n---\n\n");
    onPrompt(text);
  };

  if (offered !== true) return null;

  const failures = results?.filter((result) => result.outcome !== "passed") ?? [];

  return (
    <div data-testid="checks" className="mt-5">
      <div className="flex items-center gap-2">
        <p className={eyebrow}>Checks</p>
        <button
          type="button"
          data-testid="checks-run"
          disabled={running}
          onClick={() => void run()}
          className={`${button} ${focusRing} text-xs`}
        >
          {running ? "Running…" : "Run the checks"}
        </button>
      </div>

      {problem !== null && (
        <p data-testid="checks-problem" className="mt-1.5 text-xs text-neutral-500">
          {problem}
        </p>
      )}

      {output.length > 0 && (
        <div
          ref={outputRef}
          data-testid="checks-output"
          className={`mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-neutral-300 bg-neutral-50 p-2 text-xs dark:border-neutral-700 dark:bg-neutral-950 ${mono}`}
        >
          {commandBlocks(output).map((block) => (
            <div key={block.command} className="mb-2 last:mb-0">
              <p className="text-neutral-500">{block.command}</p>
              <pre className="whitespace-pre-wrap">{block.text}</pre>
            </div>
          ))}
        </div>
      )}

      {results !== null && results.length > 0 && (
        <ul className="mt-2 space-y-1 text-sm">
          {results.map((result, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: one static resolved list, never reordered
              key={index}
              data-testid={`checks-result-${index}`}
              className="flex items-center gap-2"
            >
              <span className={`${mono} text-xs`}>{result.command}</span>
              <span className={`text-xs ${OUTCOME_COLOR[result.outcome]}`}>
                {OUTCOME_WORD[result.outcome]}
              </span>
            </li>
          ))}
        </ul>
      )}

      {failures.length > 0 && (
        <button
          type="button"
          data-testid="checks-hand-to-agent"
          onClick={() => hand(failures)}
          className={`${button} ${focusRing} mt-2 text-xs`}
        >
          Hand this to the agent
        </button>
      )}
    </div>
  );
}

/** Groups the streamed chunks back into one block per command, in the order each command started —
 * chunks are not line-aligned, so splicing a header onto every chunk would shred lines mid-word. */
function commandBlocks(
  output: readonly { command: string; chunk: string }[],
): { command: string; text: string }[] {
  const blocks: { command: string; text: string }[] = [];
  for (const line of output) {
    const last = blocks[blocks.length - 1];
    if (last !== undefined && last.command === line.command) last.text += line.chunk;
    else blocks.push({ command: line.command, text: line.chunk });
  }
  return blocks;
}

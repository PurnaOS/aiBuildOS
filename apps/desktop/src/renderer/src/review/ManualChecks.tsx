import type { ChannelResponse } from "@aibuildos/ipc";
import { useEffect, useState } from "react";
import { button, eyebrow, focusRing, primary } from "../ui.js";
import { useBump } from "../workspace/revision.js";

type Artifact = ChannelResponse<"project:artifact">;

interface Outcome {
  readonly result: string;
  readonly run: string;
  readonly by: string;
}

interface ManualCase {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly string[];
  /** Written into `last_run_by` on a finish — see the component comment below for why. */
  readonly owner: string;
  readonly outcome: Outcome | null;
}

const STEPS_HEADING = "## Steps";

/**
 * The numbered `## Steps` a manual TestCase's body carries, as plain text in order.
 *
 * `splitBody` (ArtifactTab.tsx) is the bundle's other body parser, but it is keyed to
 * "## Acceptance criteria" and the `- [AC-n]` shape; a Steps section is a different heading and a
 * different list form, so this is its own small parser rather than a stretch of that one. Continuation
 * lines are joined the same way `splitBody`'s own criteria reader joins a wrapped `[AC-n]`.
 */
export function parseSteps(body: string): string[] {
  const at = body.indexOf(STEPS_HEADING);
  if (at === -1) return [];
  const after = body.slice(at + STEPS_HEADING.length);
  const next = after.search(/\n## /);
  const section = next === -1 ? after : after.slice(0, next);

  const steps: string[] = [];
  for (const line of section.split("\n")) {
    const start = /^\d+\.\s?(.*)$/.exec(line);
    if (start) {
      steps.push((start[1] ?? "").trim());
      continue;
    }
    const last = steps.length - 1;
    if (last >= 0 && /^\s+\S/.test(line)) steps[last] = `${steps[last]} ${line.trim()}`;
  }
  return steps.filter((step) => step !== "");
}

/** "2026-08-20T12:00:00.000Z" -> "2026-08-20". The outcome line says who and what; the second and
 * millisecond are not a fact anyone reading it needs. */
function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * A story's manual test cases, walked from the review (RQ-0023, ST-0035): each one's Steps as an
 * ordered checklist, finishing with pass or fail through the guarded save.
 *
 * **Who walked it.** The renderer knows no live identity — exposing one needs a new IPC channel, and
 * this slot owns no line of `contract.ts`/`ipc.ts` this wave. The smallest honest fill: a TestCase's
 * own `owner` is already this bundle's convention for whose record something is (okf-conventions §2),
 * so `last_run_by` is written as the test case's own `owner` — nothing new crosses the process
 * boundary to say it.
 */
export function ManualChecks({
  projectId,
  verifiedBy,
}: {
  projectId: string;
  verifiedBy: readonly string[];
}): React.JSX.Element | null {
  const bump = useBump();
  const [cases, setCases] = useState<ManualCase[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [ticked, setTicked] = useState<ReadonlySet<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void Promise.all(
      verifiedBy.map((id) =>
        window.aibuildos.invoke("project:artifact", { id: projectId, artifactId: id }),
      ),
    ).then((artifacts) => {
      if (!live) return;
      const manual: ManualCase[] = [];
      verifiedBy.forEach((id, index) => {
        const artifact = artifacts[index] as Artifact | undefined;
        if (artifact === undefined || artifact.markdown === null) return;
        const front = artifact.frontmatter as Record<string, unknown>;
        if (front.kind !== "manual") return;

        const result = front.last_result;
        const run = front.last_run;
        const by = front.last_run_by;
        manual.push({
          id,
          title: String(front.title ?? id),
          steps: parseSteps(artifact.body),
          owner: String(front.owner ?? ""),
          outcome:
            typeof result === "string" && typeof run === "string" && typeof by === "string"
              ? { result, run, by }
              : null,
        });
      });
      setCases(manual);
    });
    return () => {
      live = false;
    };
  }, [projectId, verifiedBy]);

  const open = (id: string): void => {
    setOpenId(id);
    setTicked(new Set());
    setProblem(null);
  };

  // Closing without finishing writes nothing — there is simply no save call on this path.
  const abandon = (): void => {
    setOpenId(null);
    setTicked(new Set());
    setProblem(null);
  };

  const finish = async (result: "passed" | "failed"): Promise<void> => {
    const walked = cases?.find((testCase) => testCase.id === openId);
    if (walked === undefined) return;
    setBusy(true);
    setProblem(null);
    try {
      const saved = await window.aibuildos.invoke("project:artifact-save", {
        id: projectId,
        artifactId: walked.id,
        frontmatter: {
          last_result: result,
          last_run: new Date().toISOString(),
          last_run_by: walked.owner,
        },
      });
      if (saved.problem !== null) {
        setProblem(saved.problem);
        return;
      }
      setOpenId(null);
      setTicked(new Set());
      bump(); // the reload this triggers is what refreshes this outcome — see ReviewTab's `load`
    } finally {
      setBusy(false);
    }
  };

  if (cases === null || cases.length === 0) return null;

  return (
    <div data-testid="manual-checks" className="mt-5">
      <p className={eyebrow}>Manual checks</p>
      <ul className="mt-1.5 space-y-2 text-sm">
        {cases.map((testCase) => (
          <li key={testCase.id} data-testid={`manual-check-${testCase.id}`}>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid={`manual-check-open-${testCase.id}`}
                onClick={() => open(testCase.id)}
                className={`${button} ${focusRing} text-xs`}
              >
                {testCase.title}
              </button>
              <span
                data-testid={`manual-check-outcome-${testCase.id}`}
                className="text-xs text-neutral-500"
              >
                {testCase.outcome === null
                  ? "never walked"
                  : `${testCase.outcome.result}, ${dateOf(testCase.outcome.run)}, ${testCase.outcome.by}`}
              </span>
            </div>

            {openId === testCase.id && (
              <div className="mt-2 rounded border border-neutral-300 p-3 dark:border-neutral-700">
                {testCase.steps.length === 0 ? (
                  <p className="text-xs text-neutral-500">This test case has no steps.</p>
                ) : (
                  <ol data-testid="manual-check-steps" className="space-y-1.5">
                    {testCase.steps.map((step, index) => (
                      <li
                        // biome-ignore lint/suspicious/noArrayIndexKey: one static list, never reordered
                        key={index}
                        className="flex items-start gap-2"
                      >
                        <input
                          type="checkbox"
                          data-testid={`manual-check-step-${index}`}
                          checked={ticked.has(index)}
                          onChange={() =>
                            setTicked((current) => {
                              const next = new Set(current);
                              if (next.has(index)) next.delete(index);
                              else next.add(index);
                              return next;
                            })
                          }
                          className="mt-0.5"
                        />
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                )}

                {problem !== null && (
                  <p data-testid="manual-check-problem" className="mt-2 text-xs text-red-600">
                    {problem}
                  </p>
                )}

                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    data-testid="manual-check-passed"
                    disabled={busy}
                    onClick={() => void finish("passed")}
                    className={`${primary} ${focusRing} text-xs`}
                  >
                    Passed
                  </button>
                  <button
                    type="button"
                    data-testid="manual-check-failed"
                    disabled={busy}
                    onClick={() => void finish("failed")}
                    className={`${button} ${focusRing} text-xs`}
                  >
                    Failed
                  </button>
                  <button
                    type="button"
                    data-testid="manual-check-close"
                    disabled={busy}
                    onClick={abandon}
                    className={`${button} ${focusRing} text-xs`}
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

import type { ChannelResponse } from "@aibuildos/ipc";
import { useEffect, useRef, useState } from "react";
import { button, eyebrow, focusRing } from "../ui.js";

type RecordEntry = NonNullable<ChannelResponse<"project:record">["artifacts"]>[number];

/** True once a body carries a *well-formed* `run` fence — the same two-line command-then-URL rule
 * `previews.ts` enforces, duplicated rather than shared (main and the renderer are different
 * processes reading the same convention, not the same code — same stance as `Checks.tsx`). As
 * strict as the parser it fronts, deliberately: the template ships a placeholder fence whose URL
 * line is malformed on purpose, and a loose probe would offer every fresh project a Preview that
 * is guaranteed to fail — exactly the broken offer RQ-0025#AC-4 forbids. */
function hasRunFence(body: string): boolean {
  for (const match of body.matchAll(/^```run\n([\s\S]*?)\n```$/gm)) {
    const lines = (match[1] ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.length === 2 && /^https?:\/\//.test(lines[1] ?? "")) return true;
  }
  return false;
}

/** Whether this project declares any way to run at all, read the way `Checks.tsx` reads its own
 * availability: every active `Playbook`, its body fetched, looked at for the fence. */
async function projectHasRun(projectId: string): Promise<boolean> {
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
    if (artifact !== null && hasRunFence(artifact.body)) return true;
  }
  return false;
}

/**
 * The preview section of a story's review (RQ-0025, ST-0039, DC-0012): a toggle that starts the
 * project's declared run command and shows it beside the review in a `WebContentsView` — main's own
 * window draws that, not this component. This is a placeholder pane that reports its bounding rect
 * over `preview:bounds` on every resize and scroll, so main can lay the real view exactly on top of
 * it.
 *
 * Off by default; toggling off or this leaving the tree both stop the server (RQ-0025#AC-2) — a
 * story leaving review, not just a press of "Stop", must not orphan anything.
 */
export function Preview({ projectId }: { projectId: string }): React.JSX.Element | null {
  const [offered, setOffered] = useState<boolean | null>(null);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void projectHasRun(projectId).then((has) => {
      if (live) setOffered(has);
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  const toggle = async (): Promise<void> => {
    setProblem(null);
    if (on) {
      setOn(false);
      return;
    }
    setBusy(true);
    try {
      const result = await window.aibuildos.invoke("preview:start", { projectId });
      if (!result.ok) {
        setProblem(result.message);
        return;
      }
      setOn(true);
    } finally {
      setBusy(false);
    }
  };

  // The one place the server is actually stopped: fires when `on` flips back to `false` (the
  // toggle, above) and when this unmounts while still `on` (closing the review). Reporting zero
  // bounds first hides the view before the server it was showing is gone out from under it.
  useEffect(() => {
    if (!on) return;
    return () => {
      void window.aibuildos.invoke("preview:bounds", { x: 0, y: 0, width: 0, height: 0 });
      void window.aibuildos.invoke("preview:stop", { projectId });
    };
  }, [on, projectId]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!on || pane === null) return;

    const report = (): void => {
      const rect = pane.getBoundingClientRect();
      void window.aibuildos.invoke("preview:bounds", {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(pane);
    window.addEventListener("scroll", report, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", report, true);
    };
  }, [on]);

  if (offered !== true) return null;

  return (
    <div className="mt-5">
      <div className="flex items-center gap-2">
        <p className={eyebrow}>Preview</p>
        <button
          type="button"
          data-testid="preview-toggle"
          disabled={busy}
          onClick={() => void toggle()}
          className={`${button} ${focusRing} text-xs`}
        >
          {on ? "Stop" : busy ? "Starting…" : "Start"}
        </button>
      </div>

      {problem !== null && (
        <p
          data-testid="preview-problem"
          className="mt-1.5 whitespace-pre-wrap text-xs text-red-600"
        >
          {problem}
        </p>
      )}

      {on && (
        <div
          ref={paneRef}
          data-testid="preview-pane"
          className="mt-2 h-80 rounded border border-neutral-300 dark:border-neutral-700"
        />
      )}
    </div>
  );
}

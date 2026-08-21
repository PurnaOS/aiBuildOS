import { Check, Circle } from "lucide-react";
import { useEffect, useState } from "react";
import { PermissionCard, type PermissionInfo } from "../dock/PermissionCard.js";
import { eyebrow, mono } from "../ui.js";

/**
 * The plan and the agent's questions (ST-0010, ST-0011).
 *
 * Both come from the same AG-UI event stream the transcript is drawn from, but neither belongs
 * *inside* the transcript: a plan buried in the scrollback is not an answer to "how far along is
 * it", and a question that scrolls away is a turn that never finishes.
 *
 * So both sit above the composer, where they stay visible. The permission itself is answered by the
 * one shared `PermissionCard` (RQ-0044#AC-6, ST-0063) — this component still owns *tracking* which
 * permission is open, since that is the same AG-UI stream the plan reads, but rendering the answer is
 * no longer this file's copy to keep in step with the dock's.
 */
interface PlanEntry {
  content: string;
  status?: string;
}

/** The `name` the bridge puts on each custom event. Kept in step with `packages/acp/src/bridge.ts`. */
const CUSTOM = { plan: "acp.plan", permission: "acp.permission" };

export function Activity({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const [plan, setPlan] = useState<PlanEntry[]>([]);
  const [permission, setPermission] = useState<PermissionInfo | null>(null);

  useEffect(() => {
    setPlan([]);
    setPermission(null);

    return window.aibuildos.subscribe("session:event", (payload) => {
      if (payload.sessionId !== sessionId) return;

      const event = payload.event as { type: string; name?: string; value?: unknown };
      if (event.type !== "CUSTOM") {
        // A turn that ends with a *live* request still open is a question nobody can answer any
        // more; one hands-off already answered is a settled record RQ-0022#AC-3 asks to stay
        // visible, not something the turn ending should hide.
        if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") {
          setPermission((current) => (current?.automatic ? current : null));
        }
        return;
      }

      if (event.name === CUSTOM.plan) {
        // The agent resends the whole plan every time and the client replaces it wholesale.
        setPlan(((event.value as { entries?: PlanEntry[] })?.entries ?? []).slice());
      }
      if (event.name === CUSTOM.permission) setPermission(event.value as PermissionInfo);
    });
  }, [sessionId]);

  if (plan.length === 0 && permission === null) return null;

  return (
    <div className="border-t border-neutral-200 dark:border-neutral-800">
      {permission && (
        <PermissionCard
          sessionId={sessionId}
          permission={permission}
          wrapperTestId="permission"
          automaticTestId="permission-automatic"
          answerTestId={(optionId) => `permission-${optionId}`}
          onAnswered={() => setPermission(null)}
        />
      )}

      {plan.length > 0 && (
        <div data-testid="plan" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2">
          <span className={eyebrow}>plan</span>
          {plan.map((entry) => (
            <span key={entry.content} className="flex items-center gap-1.5 text-xs">
              {entry.status === "completed" ? (
                <>
                  <Check size={11} className="text-neutral-500" aria-hidden />
                  <span className="text-neutral-500 line-through">{entry.content}</span>
                </>
              ) : entry.status === "in_progress" ? (
                <>
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
                  <span>{entry.content}</span>
                </>
              ) : (
                <>
                  <Circle size={9} className="text-neutral-300 dark:text-neutral-700" aria-hidden />
                  <span className="text-neutral-400">{entry.content}</span>
                </>
              )}
            </span>
          ))}
          <span className={`ml-auto text-[11px] text-neutral-500 ${mono}`}>
            {plan.filter((entry) => entry.status === "completed").length} of {plan.length}
          </span>
        </div>
      )}
    </div>
  );
}

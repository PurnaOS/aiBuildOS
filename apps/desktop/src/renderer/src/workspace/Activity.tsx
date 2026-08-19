import { AlertTriangle, Check, Circle } from "lucide-react";
import { useEffect, useState } from "react";
import { button, eyebrow, focusRing, mono, primary } from "../ui.js";

/**
 * The plan and the agent's questions (ST-0010, ST-0011).
 *
 * Both come from the same AG-UI event stream the transcript is drawn from, but neither belongs
 * *inside* the transcript: a plan buried in the scrollback is not an answer to "how far along is
 * it", and a question that scrolls away is a turn that never finishes.
 *
 * So both sit above the composer, where they stay visible.
 */
interface PlanEntry {
  content: string;
  status?: string;
}

interface Permission {
  requestId: string;
  toolCall?: { title?: string };
  options: { optionId: string; name: string; kind?: string }[];
}

/** The `name` the bridge puts on each custom event. Kept in step with `packages/acp/src/bridge.ts`. */
const CUSTOM = { plan: "acp.plan", permission: "acp.permission" };

export function Activity({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const [plan, setPlan] = useState<PlanEntry[]>([]);
  const [permission, setPermission] = useState<Permission | null>(null);
  const [answering, setAnswering] = useState(false);

  useEffect(() => {
    setPlan([]);
    setPermission(null);

    return window.aibuildos.subscribe("session:event", (payload) => {
      if (payload.sessionId !== sessionId) return;

      const event = payload.event as { type: string; name?: string; value?: unknown };
      if (event.type !== "CUSTOM") {
        // A turn that ends with a question still open is a question nobody can answer any more.
        if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") setPermission(null);
        return;
      }

      if (event.name === CUSTOM.plan) {
        // The agent resends the whole plan every time and the client replaces it wholesale.
        setPlan(((event.value as { entries?: PlanEntry[] })?.entries ?? []).slice());
      }
      if (event.name === CUSTOM.permission) setPermission(event.value as Permission);
    });
  }, [sessionId]);

  const answer = async (optionId: string | null): Promise<void> => {
    if (!permission) return;

    setAnswering(true);
    try {
      await window.aibuildos.invoke("session:permission", {
        sessionId,
        requestId: permission.requestId,
        optionId,
      });
      setPermission(null);
    } finally {
      setAnswering(false);
    }
  };

  if (plan.length === 0 && permission === null) return null;

  return (
    <div className="border-t border-neutral-200 dark:border-neutral-800">
      {permission && (
        <div
          data-testid="permission"
          className="border-b border-neutral-200 bg-amber-50 px-4 py-3 dark:border-neutral-800 dark:bg-amber-950/30"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={13} className="shrink-0 text-amber-600" aria-hidden />
            <span className={`${eyebrow} text-amber-700 dark:text-amber-500`}>waiting for you</span>
          </div>
          <p className="mt-1.5 text-sm">
            {permission.toolCall?.title ?? "The agent needs permission."}
          </p>

          {/* One control per option the agent sent, in the agent's own words. Nothing invented. */}
          <div className="mt-2.5 flex flex-wrap gap-2">
            {permission.options.map((option, index) => (
              <button
                key={option.optionId}
                type="button"
                data-testid={`permission-${option.optionId}`}
                disabled={answering}
                onClick={() => void answer(option.optionId)}
                className={`${index === 0 ? primary : button} ${focusRing}`}
              >
                {option.name}
              </button>
            ))}
          </div>
        </div>
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

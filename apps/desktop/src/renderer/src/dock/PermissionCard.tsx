import { AlertTriangle, Check } from "lucide-react";
import { useState } from "react";
import { button, eyebrow, focusRing, primary } from "../ui.js";

/**
 * The one permission-answering card (RQ-0044#AC-6, ST-0063): everywhere a permission appears —
 * `Activity.tsx` (Chat's transcript and a build session's own tab), and a dock Builds row — renders
 * this, instead of each keeping its own near-copy. Answering is the one thing this owns: the invoke
 * and the disabled-while-answering state live here, not in every caller, so "exactly one answer"
 * (ST-0063#AC-2) is one guard rather than three.
 *
 * Testids are parameterised because the three sites this replaces never shared a naming scheme —
 * `Activity.tsx` used flat `permission`/`permission-<optionId>`, Now used `now-row-waiting-<id>` and
 * `now-row-answer-<id>-<optionId>` — and DC-0027 keeps every existing name on its new home.
 */
export interface PermissionInfo {
  readonly requestId: string;
  readonly toolCall?: { title?: string };
  readonly options: readonly { optionId: string; name: string; kind?: string }[];
  /** Set when hands-off supervision answered this one before it ever reached the screen
   * (RQ-0022#AC-3). */
  readonly automatic?: boolean;
}

export function PermissionCard({
  sessionId,
  permission,
  wrapperTestId,
  automaticTestId,
  answerTestId,
  onAnswered,
}: {
  sessionId: string;
  permission: PermissionInfo;
  wrapperTestId: string;
  automaticTestId: string;
  answerTestId: (optionId: string) => string;
  /** Called once the answer lands, so the caller can drop its own bookkeeping for this session —
   * `Activity.tsx` clears its local `permission`, the dock clears its permission map. */
  onAnswered: () => void;
}): React.JSX.Element {
  const [answering, setAnswering] = useState(false);

  const answer = async (optionId: string | null): Promise<void> => {
    setAnswering(true);
    try {
      await window.aibuildos.invoke("session:permission", {
        sessionId,
        requestId: permission.requestId,
        optionId,
      });
      onAnswered();
    } finally {
      setAnswering(false);
    }
  };

  return (
    <div
      data-testid={wrapperTestId}
      className={`border-b border-neutral-200 px-4 py-3 dark:border-neutral-800 ${
        permission.automatic
          ? "bg-neutral-50 dark:bg-neutral-900"
          : "bg-amber-50 dark:bg-amber-950/30"
      }`}
    >
      <div className="flex items-center gap-2">
        {permission.automatic ? (
          <Check size={13} className="shrink-0 text-neutral-500" aria-hidden />
        ) : (
          <AlertTriangle size={13} className="shrink-0 text-amber-600" aria-hidden />
        )}
        <span
          className={`${eyebrow} ${
            permission.automatic ? "text-neutral-500" : "text-amber-700 dark:text-amber-500"
          }`}
        >
          {permission.automatic ? "answered automatically" : "waiting for you"}
        </span>
      </div>
      <p className="mt-1.5 text-sm">
        {permission.toolCall?.title ?? "The agent needs permission."}
      </p>

      {permission.automatic ? (
        // Settled, not a decision left to make — a line, not buttons for a click that already
        // happened (RQ-0022#AC-3).
        <p data-testid={automaticTestId} className="mt-2.5 text-xs text-neutral-500">
          Allowed automatically — hands-off supervision.
        </p>
      ) : (
        // One control per option the agent sent, in the agent's own words. Nothing invented.
        <div className="mt-2.5 flex flex-wrap gap-2">
          {permission.options.map((option, index) => (
            <button
              key={option.optionId}
              type="button"
              data-testid={answerTestId(option.optionId)}
              disabled={answering}
              onClick={() => void answer(option.optionId)}
              className={`${index === 0 ? primary : button} ${focusRing}`}
            >
              {option.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

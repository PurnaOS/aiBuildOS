import { useEffect, useState } from "react";
import { button, eyebrow, focusRing, mono } from "../ui.js";
import { Activity } from "../workspace/Activity.js";

/** The `name`s a build session's own narration carries beyond AG-UI's standard vocabulary — matched
 * against `packages/acp/src/bridge.ts`'s `CUSTOM` and `builds.ts`'s checkpoint note. */
const TOOL_CALL = "acp.tool_call";
const CHECKPOINT = "aibuildos.checkpoint";

interface Line {
  readonly id: string;
  readonly text: string;
}

/**
 * One build session's stream, opened from Now (RQ-0021, ST-0038). Tab id: `session:<sessionId>`.
 *
 * This session was never handed to CopilotKit — `session:prompt` was sent to it directly from the
 * board, so there is no `AcpAgent`/provider pair here the way `Chat.tsx` has one. What "shows its
 * conversation" (ST-0038#AC-3) honestly means for a session like that is a plain reduction of its own
 * `session:event` stream: the text it has said, the tools it ran, and — reused unmodified, since it
 * already draws exactly this — the plan and any permission still waiting via `<Activity>`.
 */
export function SessionTab({
  sessionId,
}: {
  projectId: string;
  sessionId: string;
}): React.JSX.Element {
  const [state, setState] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);

  useEffect(() => {
    setState(null);
    setLines([]);
    const open = new Map<string, number>();

    return window.aibuildos.subscribe("session:event", (payload) => {
      if (payload.sessionId !== sessionId) return;
      const event = payload.event as {
        type: string;
        name?: string;
        messageId?: string;
        delta?: string;
        value?: unknown;
      };

      if (event.type === "TEXT_MESSAGE_CONTENT" && typeof event.messageId === "string") {
        const id = event.messageId;
        setLines((current) => {
          const at = open.get(id);
          if (at !== undefined) {
            const next = [...current];
            const line = next[at];
            if (line) next[at] = { id, text: line.text + (event.delta ?? "") };
            return next;
          }
          open.set(id, current.length);
          return [...current, { id, text: event.delta ?? "" }];
        });
        return;
      }

      if (event.type === "CUSTOM" && event.name === TOOL_CALL) {
        const title = (event.value as { title?: string })?.title ?? "a tool";
        setLines((current) => [
          ...current,
          { id: `tool-${current.length}`, text: `Ran: ${title}` },
        ]);
        return;
      }

      if (event.type === "CUSTOM" && event.name === CHECKPOINT) {
        const value = event.value as { ok?: boolean; message?: string };
        if (value?.ok === false) {
          setLines((current) => [
            ...current,
            { id: `checkpoint-${current.length}`, text: `Checkpoint not saved: ${value.message}` },
          ]);
        }
        return;
      }

      if (
        event.type === "RUN_FINISHED" ||
        event.type === "RUN_ERROR" ||
        event.type === "RUN_STARTED"
      ) {
        setState(event.type);
      }
    });
  }, [sessionId]);

  const cancel = (): void => {
    void window.aibuildos.invoke("session:cancel", { sessionId });
  };

  return (
    <div data-testid="session-tab" className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 p-3 dark:border-neutral-800">
        <p className={mono}>{sessionId}</p>
        <div className="flex items-center gap-2">
          <span data-testid="session-state" className="text-xs text-neutral-500">
            {state ?? "starting"}
          </span>
          <button
            type="button"
            data-testid="session-cancel"
            onClick={cancel}
            className={`${button} ${focusRing} text-xs`}
          >
            Cancel
          </button>
        </div>
      </div>

      <Activity sessionId={sessionId} />

      <div data-testid="session-transcript" className="min-h-0 flex-1 overflow-auto p-3">
        {lines.length === 0 ? (
          <p className="text-xs text-neutral-500">Nothing has been said yet.</p>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            {lines.map((line) => (
              <p key={line.id} className="whitespace-pre-wrap">
                {line.text}
              </p>
            ))}
          </div>
        )}
      </div>
      <p
        className={`${eyebrow} shrink-0 border-t border-neutral-200 px-3 py-1.5 dark:border-neutral-800`}
      >
        closing this tab stops nothing
      </p>
    </div>
  );
}

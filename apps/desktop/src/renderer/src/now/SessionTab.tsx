import { useEffect, useState } from "react";
import { button, eyebrow, focusRing, mono } from "../ui.js";
import { Activity } from "../workspace/Activity.js";
import { getSessionToolCalls } from "../workspace/toolCall.js";

/** The `name` a build session's own narration carries beyond AG-UI's standard vocabulary — matched
 * against `builds.ts`'s checkpoint note. Tool calls need no such name of their own any more (BG-0008):
 * they are the standard `TOOL_CALL_*` events every other surface already reads. */
const CHECKPOINT = "aibuildos.checkpoint";

interface Line {
  readonly id: string;
  readonly text: string;
}

/** "completed"/"failed" in the words this tab already uses elsewhere; still running or pending says
 * nothing yet, since a second line reports the outcome once one exists. */
function outcomeWord(status: string | undefined): string | null {
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  return null;
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
    // Seeded from the shared store rather than starting empty: `session:event` is never replayed
    // for a late subscriber, and every tab a human opens is late for a fast build's calls
    // (BG-0008). Whatever ran before this mount is history the store already holds.
    setLines(
      getSessionToolCalls(sessionId).map((call, index) => ({
        id: `tool-seed-${index}`,
        text:
          call.outcome && call.outcome !== "running"
            ? `Ran: ${call.title ?? "a tool"} — ${call.outcome}`
            : `Ran: ${call.title ?? "a tool"}`,
      })),
    );
    const open = new Map<string, number>();
    // A tool call's title, kept from its start so the line its result closes can still name it —
    // the result event itself carries only the id.
    const titles = new Map<string, string>();

    return window.aibuildos.subscribe("session:event", (payload) => {
      if (payload.sessionId !== sessionId) return;
      const event = payload.event as {
        type: string;
        name?: string;
        messageId?: string;
        delta?: string;
        value?: unknown;
        toolCallId?: string;
        content?: string;
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

      // The standard events every other surface already reads (BG-0008) — the dead `acp.tool_call`
      // name this branch used to listen for was never once emitted.
      if (event.type === "TOOL_CALL_ARGS" && typeof event.delta === "string") {
        let args: { title?: string; status?: string } | null;
        try {
          args = JSON.parse(event.delta);
        } catch {
          args = null;
        }
        const title = args?.title ?? "a tool";
        if (typeof event.toolCallId === "string") titles.set(event.toolCallId, title);
        // A call already terminal by the time it starts (the common case for a single scripted
        // edit) never gets a separate result event, so its outcome is said here or not at all.
        const outcome = outcomeWord(args?.status);
        setLines((current) => [
          ...current,
          {
            id: `tool-${current.length}`,
            text: outcome ? `Ran: ${title} — ${outcome}` : `Ran: ${title}`,
          },
        ]);
        return;
      }

      if (event.type === "TOOL_CALL_RESULT" && typeof event.content === "string") {
        let result: { status?: string } | null;
        try {
          result = JSON.parse(event.content);
        } catch {
          result = null;
        }
        const title =
          (typeof event.toolCallId === "string" ? titles.get(event.toolCallId) : undefined) ??
          "The tool call";
        const outcome = outcomeWord(result?.status) ?? "finished";
        setLines((current) => [
          ...current,
          { id: `tool-result-${current.length}`, text: `${title} — ${outcome}` },
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

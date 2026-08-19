import { AbstractAgent } from "@ag-ui/client";
import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { Observable } from "rxjs";

/**
 * The renderer's side of a live agent session (ST-0009, DC-0017).
 *
 * Deliberately thin. All the work — spawning the agent, holding the session, translating the
 * protocol — happens in the main process, so this only has to turn events arriving over IPC into the
 * observable `@ag-ui/client` expects. It knows nothing about ACP; if it did, DC-0008's promise that
 * the renderer consumes AG-UI only would already be broken.
 */
export class AcpAgent extends AbstractAgent {
  constructor(private readonly sessionId: string) {
    super();
  }

  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      // Subscribe *before* prompting. The agent's first events can arrive while the invoke is still
      // in flight, and a subscription opened afterwards would miss them.
      const stop = window.aibuildos.subscribe("session:event", (payload) => {
        if (payload.sessionId !== this.sessionId) return;

        const event = payload.event as unknown as BaseEvent;
        subscriber.next(event);

        // Main is the authority on when a turn is over: it is holding the session and it saw the
        // agent's own stop reason.
        if (event.type === "RUN_FINISHED" || event.type === "RUN_ERROR") subscriber.complete();
      });

      const text = lastUserText(input);
      if (text === null) {
        stop();
        subscriber.complete();
        return;
      }

      window.aibuildos
        .invoke("session:prompt", { sessionId: this.sessionId, text })
        .catch((cause: unknown) => subscriber.error(cause));

      return () => stop();
    });
  }

  /** Ask the agent to stop. The turn still ends on the agent's terms, which is what the protocol says. */
  async cancel(): Promise<void> {
    await window.aibuildos.invoke("session:cancel", { sessionId: this.sessionId });
  }
}

/**
 * The message this run is being asked about.
 *
 * CopilotKit hands over the whole conversation on every run; main already has the history, so only
 * the newest thing the user said needs sending.
 */
function lastUserText(input: RunAgentInput): string | null {
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message?.role !== "user") continue;

    const content = message.content;
    if (typeof content === "string" && content.trim() !== "") return content;
    return null;
  }
  return null;
}

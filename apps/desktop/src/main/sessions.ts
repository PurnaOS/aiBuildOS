import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import { CUSTOM } from "@aibuildos/acp/bridge";
import { AgentSession, type PermissionRequest, SessionError } from "@aibuildos/acp/session";
import type { EventName, EventPayload } from "@aibuildos/ipc";
import type { Harness } from "./harnesses.js";

/**
 * Every live agent session this application is holding (ST-0009).
 *
 * The sessions themselves live in `@aibuildos/acp`; what belongs here is everything that only makes
 * sense with a window attached — which session is which, how a permission request reaches a person,
 * and how a session's lifecycle is narrated to the renderer.
 *
 * A permission request is the one place the two halves of the boundary meet. The agent asks main;
 * main cannot answer, because only a person can. So the question goes out as an **event** and the
 * answer comes back as an ordinary typed **request**, correlated by an id this module mints. That is
 * the shape [DC-0017](../../../../docs/decisions/dc-0017.md) settled on, and it is why an event
 * channel that could carry replies was rejected.
 */
export type Emit = <E extends EventName>(event: E, payload: EventPayload<E>) => void;

interface Held {
  readonly session: AgentSession;
  /** Permission requests this session is waiting on, by the id we gave them. */
  readonly pending: Map<string, (optionId: string | null) => void>;
}

export type StartResult =
  | { ok: true; sessionId: string; offered: Record<string, unknown> }
  | { ok: false; code: string; message: string; authMethods: { id: string; name: string }[] };

export class SessionRegistry {
  private readonly held = new Map<string, Held>();

  constructor(private readonly emit: Emit) {}

  async start(harness: Harness, cwd: string, clientVersion: string): Promise<StartResult> {
    // The id the pending map is keyed by has to exist before the session does, because the agent can
    // ask for permission during the very first turn.
    const pending = new Map<string, (optionId: string | null) => void>();
    let sessionId = "";

    try {
      const session = await AgentSession.open(
        { command: harness.command, args: harness.args },
        {
          cwd,
          clientVersion,
          onEvent: (event) => {
            this.emit("session:event", {
              sessionId,
              event: event as unknown as { type: string },
            });
          },
          onPermission: (request) => this.ask(() => sessionId, pending, request),
        },
      );

      sessionId = session.sessionId;
      this.held.set(sessionId, { session, pending });
      this.emit("session:state", { sessionId, state: "ready", error: null });

      return {
        ok: true,
        sessionId,
        offered: session.offered as unknown as Record<string, unknown>,
      };
    } catch (cause) {
      const error =
        cause instanceof SessionError
          ? cause
          : new SessionError(
              "protocol_error",
              cause instanceof Error ? cause.message : String(cause),
            );

      this.emit("session:state", {
        sessionId: sessionId || "unstarted",
        state: "failed",
        error: { code: error.code, message: error.message },
      });

      return {
        ok: false,
        code: error.code,
        message: error.message,
        authMethods: [...error.authMethods],
      };
    }
  }

  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    const held = this.require(sessionId);

    this.emit("session:state", { sessionId, state: "busy", error: null });
    try {
      return { stopReason: await held.session.prompt(text) };
    } finally {
      this.emit("session:state", { sessionId, state: "ready", error: null });
    }
  }

  /**
   * Ask the agent to stop.
   *
   * Any permission request still outstanding is answered as cancelled first — the protocol requires
   * it, and an agent left waiting on a question nobody will now answer would hang the turn forever.
   */
  async cancel(sessionId: string): Promise<void> {
    const held = this.require(sessionId);

    for (const [, answer] of held.pending) answer(null);
    held.pending.clear();

    await held.session.cancel();
  }

  answerPermission(sessionId: string, requestId: string, optionId: string | null): void {
    const held = this.require(sessionId);
    const answer = held.pending.get(requestId);
    // A request that is already gone is not an error: the turn may have been cancelled between the
    // question reaching the screen and the click coming back.
    if (!answer) return;

    held.pending.delete(requestId);
    answer(optionId);
  }

  async close(sessionId: string): Promise<void> {
    const held = this.held.get(sessionId);
    if (!held) return;

    this.held.delete(sessionId);
    for (const [, answer] of held.pending) answer(null);
    await held.session.close();
    this.emit("session:state", { sessionId, state: "closed", error: null });
  }

  /** Used when the application is quitting: no agent outlives the window that started it. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.held.keys()].map((id) => this.close(id)));
  }

  /**
   * Put a permission request on screen and wait for the answer.
   *
   * It travels as an AG-UI `CUSTOM` event so the renderer still consumes AG-UI and nothing else
   * (DC-0008). The `requestId` is what the answer comes back on.
   */
  private ask(
    sessionId: () => string,
    pending: Map<string, (optionId: string | null) => void>,
    request: PermissionRequest,
  ): Promise<string | null> {
    const requestId = randomUUID();

    return new Promise<string | null>((resolve) => {
      pending.set(requestId, resolve);
      this.emit("session:event", {
        sessionId: sessionId(),
        event: {
          type: EventType.CUSTOM,
          name: CUSTOM.permission,
          value: { requestId, toolCall: request.toolCall, options: request.options },
        } as unknown as { type: string },
      });
    });
  }

  private require(sessionId: string): Held {
    const held = this.held.get(sessionId);
    // Prompting a session that is not open is a renderer bug, not something a user did.
    if (!held) throw new Error(`no open session with id ${sessionId}`);
    return held;
  }
}

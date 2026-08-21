import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import { CUSTOM } from "@aibuildos/acp/bridge";
import { AgentSession, type PermissionRequest, SessionError } from "@aibuildos/acp/session";
import type { EventName, EventPayload } from "@aibuildos/ipc";
import type { Harness } from "./harnesses.js";
import { landPlan, recordVerdict } from "./typedRecord.js";

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

/** RQ-0022. `hands-off` answers a permission request with the agent's own allow option; `closest`
 * blocks for a person, as every session did before this setting existed. */
export type SupervisionLevel = "closest" | "hands-off";

/** RQ-0021's consequence #2, shared with RQ-0039: a ceiling raised deliberately, never discovered
 * under load. Builds and background runs draw from the same 3 slots (`busyCount`). */
export const BUSY_CAP = 3;

interface Held {
  readonly session: AgentSession;
  /** Which project this session belongs to — what the supervision level is read against. */
  readonly projectId: string;
  /** The harness record this session was started from — where the supervision mapping lives
   * (RQ-0050#AC-2), read again whenever the level changes mid-run. */
  readonly harness: Harness;
  /** The story this is a build session for; `null` for the workspace's own conversation
   * (RQ-0021 — what `session:list` and the concurrency cap distinguish on). */
  readonly storyId: string | null;
  /** A background run's label — the playbook's title (RQ-0039/RQ-0040); `null` otherwise. */
  readonly label: string | null;
  /** ISO-8601, stamped when the session opened (RQ-0040). */
  readonly startedAt: string;
  /** Permission requests this session is waiting on, by the id we gave them. */
  readonly pending: Map<string, (optionId: string | null) => void>;
  /**
   * The last thing the agent said about how it is set up.
   *
   * Remembered because an agent announces this the moment a session opens, long before any component
   * has mounted to hear it. Events carry the changes; this carries the starting point.
   */
  controls: Controls;
}

/** One row of `session:list` (RQ-0021) — what the Now surface derives from. */
export interface SessionRow {
  readonly sessionId: string;
  readonly projectId: string;
  readonly storyId: string | null;
  readonly label: string | null;
  readonly startedAt: string;
}

export interface Controls {
  modeId: string | null;
  configOptions: { id: string }[];
  commands: { name: string }[];
}

export type StartResult =
  | { ok: true; sessionId: string; offered: Record<string, unknown> }
  | { ok: false; code: string; message: string; authMethods: { id: string; name: string }[] };

export class SessionRegistry {
  /** See `start`: the registry keys sessions itself, because agent ids collide across processes. */
  private static minted = 1;

  private readonly held = new Map<string, Held>();
  /** Listeners for one session's turn ending, keyed by session id (RQ-0020#AC-3) — how a build
   * session's checkpoint gets wired without `builds.ts` holding a `session:event` subscription of
   * its own; main has no event bus a second module could listen on except what this offers. */
  private readonly turnEndListeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly emit: Emit,
    /**
     * The project's current supervision level. Called fresh on every permission request rather than
     * read once at start, so a level changed mid-session applies from the next request and nothing
     * already answered is revisited (RQ-0022#AC-5).
     */
    private readonly supervisionOf: (projectId: string) => SupervisionLevel,
  ) {}

  async start(
    harness: Harness,
    projectId: string,
    cwd: string,
    clientVersion: string,
    /** Set only for a build session (RQ-0020); `null` for the workspace's own conversation. */
    storyId: string | null = null,
    /** Set only for a background playbook run (RQ-0039); `null` otherwise. */
    label: string | null = null,
  ): Promise<StartResult> {
    // The id the pending map is keyed by has to exist before the session does, because the agent can
    // ask for permission during the very first turn.
    const pending = new Map<string, (optionId: string | null) => void>();
    const controls: Controls = { modeId: null, configOptions: [], commands: [] };
    let sessionId = "";

    try {
      const session = await AgentSession.open(
        { command: harness.command, args: harness.args },
        {
          cwd,
          clientVersion,
          onEvent: (event) => {
            remember(
              controls,
              event as unknown as { type: string; name?: string; value?: unknown },
            );
            this.emit("session:event", {
              sessionId,
              event: event as unknown as { type: string },
            });
            // A turn's end, for whoever registered to hear it (builds.ts's checkpoint). Cancelled
            // included: DC-0021 checkpoints "each turn's end", and a cancelled turn still ends one —
            // only a genuine protocol failure never reaches `runFinished` at all.
            const type = (event as unknown as { type?: string }).type;
            if (type === "RUN_FINISHED" || type === "RUN_ERROR") {
              for (const listener of this.turnEndListeners.get(sessionId) ?? []) listener();
            }
          },
          onPermission: (request) => this.ask(() => sessionId, pending, projectId, request),
          // The typed-record extension's landing half (RQ-0052): a plan becomes draft artifacts in
          // this session's own working tree, a verdict a guarded frontmatter save — both in main,
          // never the renderer, riding the same session events everything else rides (no new IPC
          // channel, DC-0028). An agent that never advertised the extension never calls either.
          onPlan: (payload) => landPlan(cwd, harness.displayName, payload),
          onVerdict: (payload) => {
            const problem = recordVerdict(cwd, harness.displayName, payload);
            // A notification cannot be rejected, so an invalid verdict is dropped — but narrated,
            // the same way a checkpoint's refusal is (`aibuildos.flip`'s idiom).
            if (problem !== null) {
              this.noteCustom(sessionId, "aibuildos.verdict", { ok: false, message: problem });
            }
          },
        },
      );

      // The registry's own key, never the agent's: an ACP session id is unique only within one
      // agent process, and two builds running two stubs proved two processes can answer with the
      // same one — the second registration silently clobbering the first (RQ-0021#AC-1). The
      // `AgentSession` keeps speaking ACP with the agent's id; everything on this side of the
      // boundary — the held map, events, turn-end listeners — speaks this one.
      sessionId = `s${SessionRegistry.minted++}-${session.sessionId}`;
      controls.modeId ??= session.offered.modes?.currentModeId ?? null;
      if (controls.configOptions.length === 0) {
        controls.configOptions = (session.offered.configOptions ?? []) as { id: string }[];
      }
      const held: Held = {
        session,
        projectId,
        harness,
        storyId,
        label,
        startedAt: new Date().toISOString(),
        pending,
        controls,
      };
      this.held.set(sessionId, held);

      // The project's supervision level, reaching the agent (RQ-0050#AC-1). Awaited before `ready`
      // so the controls cache the renderer reads on mount already holds what the level applied,
      // rather than the value the agent happened to wake up with.
      await this.push(sessionId, held, this.supervisionOf(projectId));

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

  /** Where things stood before whoever is asking started listening. */
  controlsOf(sessionId: string): Controls {
    return this.require(sessionId).controls;
  }

  /** Every live session, for `session:list` (RQ-0021) and for `builds.ts`'s concurrency cap — the
   * registry is the one place that knows about every session, build or not. */
  /**
   * Sessions holding one of the 3 busy slots (RQ-0039): builds and background runs, never the
   * main conversation. The one number `build:start` and a background `session:start` both read.
   */
  busyCount(): number {
    return [...this.held.values()].filter((held) => held.storyId !== null || held.label !== null)
      .length;
  }

  list(): SessionRow[] {
    return [...this.held.entries()].map(([sessionId, held]) => ({
      sessionId,
      projectId: held.projectId,
      storyId: held.storyId,
      label: held.label,
      startedAt: held.startedAt,
    }));
  }

  /**
   * Carry a supervision level to every open session of one project, and to no other project's
   * (RQ-0050#AC-1) — the fan-out `project:set-supervision` calls when the level changes mid-run.
   *
   * Reading `held` is the whole project→sessions index: one map already keyed by session id and
   * carrying `projectId` on every entry, so a second index would only be a second thing to keep
   * true. Each session's push settles on its own — one agent refusing must not skip the rest.
   */
  async applySupervision(projectId: string, level: SupervisionLevel): Promise<void> {
    await Promise.all(
      [...this.held.entries()]
        .filter(([, held]) => held.projectId === projectId)
        .map(([sessionId, held]) => this.push(sessionId, held, level)),
    );
  }

  /**
   * One session's half of that, and the only place the mapping is read: a pure lookup on the
   * harness record, so no harness is named in code (RQ-0050#AC-2).
   *
   * The record says what this harness maps; the *agent* says what it actually offers, and only the
   * agent is the authority on the second. An option it never advertised is narrated on the session's
   * own stream and left alone — the level still holds on this side, which is exactly what AC-3 asks
   * the surface to say rather than a failure to invent.
   */
  private async push(sessionId: string, held: Held, level: SupervisionLevel): Promise<void> {
    const mapped = held.harness.supervisionOptions?.[level];
    if (mapped === undefined) return;

    const message = held.controls.configOptions.some((option) => option.id === mapped.configId)
      ? await held.session
          .setConfigOption(mapped.configId, mapped.value)
          .then(() => null)
          .catch((cause: unknown) => (cause instanceof Error ? cause.message : String(cause)))
      : `${held.harness.displayName} advertises no "${mapped.configId}" option, so supervision applies in aiBuildOS only.`;

    if (message !== null) {
      this.noteCustom(sessionId, "aibuildos.supervision", { ok: false, message });
    }
  }

  /** Hear this session's turns end (RQ-0020#AC-3). Returns the unsubscribe; `close()` also clears
   * every listener for a session that is gone, so a caller that forgets to call it back is not a
   * leak. */
  onTurnEnd(sessionId: string, listener: () => void): () => void {
    const listeners = this.turnEndListeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.turnEndListeners.set(sessionId, listeners);
    return () => listeners.delete(listener);
  }

  /**
   * Push a `CUSTOM` event into a session's own stream, in the same envelope a permission question
   * uses — for narration that originates outside the agent itself, such as a checkpoint's hook
   * rejection (RQ-0020#AC-3). The wire's `BuildRow` carries no field for prose like this; the
   * session's own event stream is where it can actually be said.
   */
  noteCustom(sessionId: string, name: string, value: unknown): void {
    this.emit("session:event", {
      sessionId,
      event: { type: EventType.CUSTOM, name, value } as unknown as { type: string },
    });
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.require(sessionId).session.setMode(modeId);
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<void> {
    await this.require(sessionId).session.setConfigOption(configId, value);
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
    this.turnEndListeners.delete(sessionId);
    for (const [, answer] of held.pending) answer(null);
    await held.session.close();
    this.emit("session:state", { sessionId, state: "closed", error: null });
  }

  /** Used when the application is quitting: no agent outlives the window that started it. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.held.keys()].map((id) => this.close(id)));
  }

  /**
   * Put a permission request on screen and wait for the answer — unless the project is hands-off, in
   * which case the agent's own allow option answers it at once (RQ-0022#AC-3). Either way it travels
   * as an AG-UI `CUSTOM` event so the renderer still consumes AG-UI and nothing else (DC-0008); the
   * `requestId` is what a live answer comes back on, and an automatic one carries `automatic: true`
   * so the card can say so instead of drawing buttons for a decision already made.
   */
  private ask(
    sessionId: () => string,
    pending: Map<string, (optionId: string | null) => void>,
    projectId: string,
    request: PermissionRequest,
  ): Promise<string | null> {
    const requestId = randomUUID();
    const automatic =
      this.supervisionOf(projectId) === "hands-off" ? allowOption(request.options) : null;

    this.emit("session:event", {
      sessionId: sessionId(),
      event: {
        type: EventType.CUSTOM,
        name: CUSTOM.permission,
        value: {
          requestId,
          toolCall: request.toolCall,
          options: request.options,
          ...(automatic === null ? {} : { automatic: true }),
        },
      } as unknown as { type: string },
    });

    if (automatic !== null) return Promise.resolve(automatic);

    return new Promise<string | null>((resolve) => {
      pending.set(requestId, resolve);
    });
  }

  private require(sessionId: string): Held {
    const held = this.held.get(sessionId);
    // Prompting a session that is not open is a renderer bug, not something a user did.
    if (!held) throw new Error(`no open session with id ${sessionId}`);
    return held;
  }
}

/**
 * Which option answers a hands-off request: the agent's own "allow once" first, "allow always"
 * otherwise, and `null` when it offered no way to allow at all — which keeps the request blocking for
 * a person even at hands-off, because there is nothing honest to answer it with (RQ-0022#AC-3).
 */
function allowOption(options: PermissionRequest["options"]): string | null {
  return (
    (
      options.find((option) => option.kind === "allow_once") ??
      options.find((option) => option.kind === "allow_always")
    )?.optionId ?? null
  );
}

/** Keep the remembered controls in step with what the agent announces. */
function remember(
  controls: Controls,
  event: { type: string; name?: string; value?: unknown },
): void {
  if (event.type !== "CUSTOM") return;

  if (event.name === CUSTOM.mode) {
    controls.modeId = (event.value as { currentModeId?: string })?.currentModeId ?? controls.modeId;
  }
  if (event.name === CUSTOM.configOptions) {
    controls.configOptions =
      (event.value as { configOptions?: { id: string }[] })?.configOptions ??
      controls.configOptions;
  }
  if (event.name === CUSTOM.commands) {
    controls.commands =
      (event.value as { availableCommands?: { name: string }[] })?.availableCommands ??
      controls.commands;
  }
}

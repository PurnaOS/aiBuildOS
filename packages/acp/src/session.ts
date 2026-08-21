import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import type { BaseEvent } from "@ag-ui/core";
import {
  type ActiveSession,
  type AgentCapabilities,
  client,
  methods,
  type NewSessionResponse,
  ndJsonStream,
  type PermissionOption,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { CUSTOM, SessionBridge } from "./bridge.js";
import type { LaunchSpec } from "./index.js";
import { killTree, spawnDetached } from "./reap.js";

/**
 * A live agent session, held open across prompts (ST-0009).
 *
 * `probe.ts` proves a harness answers *once* and then kills it. This is the other thing: one agent,
 * one session, many turns — which is what a conversation is.
 *
 * Everything it narrates leaves as **AG-UI events**, already bridged, so the agent's wire format
 * stops here and never reaches the renderer ([DC-0017](../../../docs/decisions/dc-0017.md)).
 *
 * Node APIs only; this runs in Electron's main process (AR-0001).
 */

/**
 * The typed-record extension (RQ-0052, DC-0028), riding the spec's own extension points: support is
 * advertised in the `_meta` of the capability objects both sides exchange at `initialize`, and the
 * traffic itself travels as underscore-prefixed custom methods — the names the spec reserves for
 * exactly this. No forked protocol types, no second door.
 */
export const TYPED_RECORD = "aibuildos/typed-record";
export const TYPED_RECORD_VERSION = 1;
/** Agent → client **request**: a proposed plan, answered with acceptance or findings. */
export const PLAN_METHOD = "_aibuildos/plan";
/** Agent → client **notification**: a check verdict. Notifications cannot be rejected. */
export const VERDICT_METHOD = "_aibuildos/verdict";

export type SessionFailureCode =
  | "cwd_not_found"
  | "command_not_found"
  | "spawn_failed"
  | "exited"
  | "auth_required"
  | "protocol_error"
  | "not_open";

export class SessionError extends Error {
  constructor(
    readonly code: SessionFailureCode,
    message: string,
    /** What the agent advertised, when it refused for want of a login. */
    readonly authMethods: readonly { id: string; name: string }[] = [],
    readonly stderr = "",
  ) {
    super(message);
    this.name = "SessionError";
  }
}

/** What a permission request needs from whoever is driving — normally, a person. */
export interface PermissionRequest {
  readonly toolCall: RequestPermissionRequest["toolCall"];
  readonly options: readonly PermissionOption[];
}

export interface SessionOptions {
  readonly cwd: string;
  readonly clientVersion?: string;
  /** Every AG-UI event this session produces. */
  readonly onEvent: (event: BaseEvent) => void;
  /**
   * Answer a permission request, or resolve `null` to decline by cancelling.
   *
   * Left undefined, permission is cancelled — the same safe default the probe uses. An agent must
   * never be allowed to proceed because nobody was listening.
   */
  readonly onPermission?: (request: PermissionRequest) => Promise<string | null>;
  /**
   * Answer a typed plan proposal (RQ-0052#AC-1): whatever this resolves with is the response the
   * agent receives on `_aibuildos/plan` — `{accepted: false, findings}` is the reject-back. Left
   * undefined, every proposal is refused with a finding saying so: an agent that advertised the
   * extension deserves an answer it can act on, not a protocol error.
   */
  readonly onPlan?: (payload: unknown) => Promise<unknown>;
  /**
   * Hear a typed check verdict (RQ-0052#AC-2). A notification has no reply, so an invalid payload
   * is the receiver's to log and drop.
   */
  readonly onVerdict?: (payload: unknown) => void | Promise<void>;
}

const STDERR_LIMIT = 8 * 1024;

/** Wait for something someone else resolves. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class AgentSession {
  private turn = 0;
  private closed = false;
  /** The turn in flight, resolved by the drain loop when the agent stops. */
  private pending: {
    runId: string;
    resolve: (reason: StopReason) => void;
    reject: (cause: unknown) => void;
  } | null = null;

  private constructor(
    private readonly child: ChildProcess,
    private readonly session: ActiveSession,
    /** What the agent's `initialize` response advertised — the probe kept this, and now so does a
     * session, because extension support lives in its `_meta` (DC-0028). */
    private readonly agentCapabilities: AgentCapabilities,
    private readonly context: {
      notify: (method: string, params: unknown) => Promise<void>;
      request: (method: string, params: unknown) => Promise<unknown>;
    },
    private readonly bridge: SessionBridge,
    private readonly options: SessionOptions,
    private readonly finished: Promise<unknown>,
    private readonly stopSignal: { resolve: (value: undefined) => void },
  ) {}

  get sessionId(): string {
    return this.session.sessionId;
  }

  /** What the agent advertised when the session opened: its modes, models and effort levels. */
  get offered(): NewSessionResponse {
    return this.session.newSessionResponse;
  }

  /**
   * What the agent's `initialize` advertised for one extension in `agentCapabilities._meta`, or
   * `null` — and absent is the answer that matters: an agent advertising nothing gets exactly the
   * baseline behaviour (RQ-0052#AC-4).
   */
  extension(id: string): unknown {
    return this.agentCapabilities._meta?.[id] ?? null;
  }

  /**
   * Spawn the agent, shake hands, and open a session that stays open.
   *
   * The spawn discipline is the probe's, for the reasons the probe documents: a missing working
   * directory is ruled out first so it cannot be mistaken for a missing command, and the child gets
   * its own process group so an agent launched through `npx` is still killable.
   */
  static async open(spec: LaunchSpec, options: SessionOptions): Promise<AgentSession> {
    if (!existsSync(options.cwd)) {
      throw new SessionError(
        "cwd_not_found",
        `the working directory ${options.cwd} does not exist`,
      );
    }

    const child = spawn(spec.command, [...spec.args], {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: spawnDetached,
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_LIMIT);
    });

    const died = new Promise<never>((_resolve, reject) => {
      child.on("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "ENOENT"
            ? new SessionError("command_not_found", `${spec.command} is not on PATH`, [], stderr)
            : new SessionError("spawn_failed", error.message, [], stderr),
        );
      });
    });
    died.catch(() => undefined);

    const ready = deferred<AgentSession>();
    const stop = deferred<undefined>();
    // Resolved when the connection settles, however it settles. `close()` awaits it so the agent is
    // reaped only once the SDK has finished with the pipes.
    const finished = deferred<void>();
    // Captured during the handshake and needed by the failure path below it: an agent that refuses
    // to open a session until it is logged in advertised how to do that here, and reporting
    // `auth_required` without those methods would leave the user with nothing to act on.
    let advertised: { id: string; name: string }[] = [];
    // The session, once it exists — the extension handlers below are registered before it does, but
    // an agent can only reach them from inside a turn, by which time this is set.
    let live: AgentSession | null = null;

    const run = client({ name: "aiBuildOS" })
      // The typed-record extension (DC-0028): underscore methods, params passed through untouched —
      // the *application* validates and answers with findings, because a Zod rejection here would
      // surface as a protocol error the agent cannot conform to.
      .onRequest(PLAN_METHOD, (params: unknown) => params, async ({ params }) => {
        const response = options.onPlan
          ? await options.onPlan(params)
          : { accepted: false, findings: [{ message: "this client is not accepting plans" }] };
        live?.extensionEvent(CUSTOM.planProposal, { payload: params, response });
        return response;
      })
      .onNotification(VERDICT_METHOD, (params: unknown) => params, async ({ params }) => {
        live?.extensionEvent(CUSTOM.checkVerdict, params);
        await options.onVerdict?.(params);
      })
      .onRequest(methods.client.session.requestPermission, async ({ params }) => {
        // No answerer means no permission. An agent proceeding because nobody was listening is the
        // one outcome this must never produce.
        if (!options.onPermission) return { outcome: { outcome: "cancelled" as const } };

        const optionId = await options.onPermission({
          toolCall: params.toolCall,
          options: params.options,
        });
        return optionId === null
          ? { outcome: { outcome: "cancelled" as const } }
          : { outcome: { outcome: "selected" as const, optionId } };
      })
      .connectWith(
        ndJsonStream(
          Writable.toWeb(child.stdin as Writable) as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout as Readable) as ReadableStream<Uint8Array>,
        ),
        async (ctx) => {
          const init = await ctx.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: "aiBuildOS", version: options.clientVersion ?? "0.0.0" },
            // No baseline capabilities advertised: the agent does its own file and terminal work,
            // and brokering either on its behalf is its own requirement (EP-0004, out of scope).
            // `_meta` announces the extensions this client accepts, per the spec's own extension
            // points (DC-0028) — an agent that ignores it gets exactly today's behaviour.
            clientCapabilities: {
              _meta: { [TYPED_RECORD]: { version: TYPED_RECORD_VERSION } },
            },
          });
          advertised = (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name }));

          return await ctx.buildSession(options.cwd).withSession(async (session) => {
            const opened = new AgentSession(
              child,
              session,
              init.agentCapabilities ?? {},
              ctx as unknown as {
                notify: (m: string, p: unknown) => Promise<void>;
                request: (m: string, p: unknown) => Promise<unknown>;
              },
              new SessionBridge(session.sessionId),
              options,
              finished.promise,
              stop,
            );
            live = opened;
            // Reading starts with the session, not with the first prompt.
            void opened.drain();
            ready.resolve(opened);
            // Holding here is what keeps the session open. Returning would close it, which is
            // precisely what the probe wants and this must not do.
            await stop.promise;
          });
        },
      )
      .catch((cause: unknown) => {
        if (cause instanceof SessionError) throw cause;
        const authRequired = isAuthRequired(cause);
        const error = new SessionError(
          authRequired ? "auth_required" : child.exitCode !== null ? "exited" : "protocol_error",
          describe(cause),
          authRequired ? advertised : [],
          stderr,
        );
        ready.reject(error);
        throw error;
      });

    run.then(
      () => finished.resolve(),
      () => finished.resolve(),
    );

    try {
      return await Promise.race([ready.promise, died]);
    } catch (cause) {
      killTree(child);
      if (cause instanceof SessionError) throw cause;
      throw new SessionError("protocol_error", describe(cause), advertised, stderr);
    }
  }

  /**
   * Send a prompt and narrate the turn.
   *
   * Resolves with the reason the turn stopped, once the agent has stopped talking — not when the
   * prompt was accepted.
   */
  async prompt(text: string): Promise<StopReason> {
    if (this.closed) throw new SessionError("not_open", "this session has been closed");

    this.turn += 1;
    const runId = `${this.session.sessionId}-${this.turn}`;
    this.emit(this.bridge.runStarted(runId));

    const turn = new Promise<StopReason>((resolve, reject) => {
      this.pending = { runId, resolve, reject };
    });

    // The drain loop, not this call, decides when the turn is over: it sees the agent's updates and
    // its stop message in the order the agent sent them, so nothing is reported as finished while
    // updates are still queued behind it.
    this.session.prompt(text).catch((cause: unknown) => {
      const failed = this.pending;
      this.pending = null;
      this.emit(this.bridge.runFailed(describe(cause), "protocol_error"));
      failed?.reject(new SessionError("protocol_error", describe(cause)));
    });

    return await turn;
  }

  /**
   * Read this session's updates for as long as it is open.
   *
   * Deliberately **not** tied to a turn. An agent narrates between turns too — the commands it
   * offers, the mode it is in, the model it is set to — and a client that only drains while
   * prompting leaves all of that sitting in a queue nobody reads. That was a real bug: the controls
   * showed what the session opened with and never moved again.
   */
  private async drain(): Promise<void> {
    for (;;) {
      let message: Awaited<ReturnType<ActiveSession["nextUpdate"]>>;
      try {
        message = await this.session.nextUpdate();
      } catch {
        // The session is gone. `close()` is the ordinary way here.
        return;
      }

      if (message.kind === "stop") {
        const finished = this.pending;
        this.pending = null;
        if (finished) {
          this.emit(this.bridge.runFinished(finished.runId, message.response.stopReason));
          finished.resolve(message.response.stopReason);
        }
        continue;
      }

      this.emit(this.bridge.update(message.update));
    }
  }

  /**
   * Ask the agent to stop the turn in progress.
   *
   * A notification, so there is nothing to await and nothing to fail. The protocol requires the
   * client to go on accepting updates afterwards — which it does, because the drain loop never stops
   * reading and the turn ends only when the agent itself says it has.
   */
  async cancel(): Promise<void> {
    if (this.closed) return;
    await this.context.notify(methods.agent.session.cancel, { sessionId: this.session.sessionId });
  }

  /**
   * Change the session's mode — plan, code, whatever this agent calls them.
   *
   * The protocol allows this at any time, "whether the Agent is idle or actively generating a turn",
   * so it is not blocked mid-turn. What the interface then shows follows the agent's own
   * `current_mode_update`, not this call: the agent is the authority on what it is set to.
   */
  async setMode(modeId: string): Promise<void> {
    if (this.closed) throw new SessionError("not_open", "this session has been closed");
    await this.context.request(methods.agent.session.setMode, {
      sessionId: this.session.sessionId,
      modeId,
    });
  }

  /**
   * Change one configuration option — a model, an effort level, or whatever else the agent chose to
   * offer under a category this protocol has never heard of.
   */
  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    if (this.closed) throw new SessionError("not_open", "this session has been closed");
    await this.context.request(methods.agent.session.setConfigOption, {
      sessionId: this.session.sessionId,
      configId,
      ...(typeof value === "boolean" ? { type: "boolean" as const, value } : { value }),
    });
  }

  /** Close the session and reap the agent, along with anything it spawned. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.session.dispose();
    this.stopSignal.resolve(undefined);
    await this.finished.catch(() => undefined);
    killTree(this.child);
  }

  private emit(batch: BaseEvent[]): void {
    for (const event of batch) this.options.onEvent(event);
  }

  /** Extension traffic leaves as bridged `CUSTOM` events like everything else — no new door. */
  private extensionEvent(name: string, value: unknown): void {
    this.emit(this.bridge.extension(name, value));
  }
}

/** An agent that will not open a session until it is logged in answers with this JSON-RPC code. */
function isAuthRequired(cause: unknown): boolean {
  const code = (cause as { code?: unknown })?.code;
  return code === -32000;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : JSON.stringify(cause);
}

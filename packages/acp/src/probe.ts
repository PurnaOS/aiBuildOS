import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
} from "@agentclientprotocol/sdk";
import type { LaunchSpec } from "./index.js";

/**
 * The harness probe: spawn an agent, complete a full ACP round trip, report what happened, and
 * always reap the child (RQ-0001 AC-5 … AC-8).
 *
 * A handshake alone cannot answer the question the user is actually asking — "will this thing answer
 * me?" — so the probe goes all the way to a prompt and a reply. That means a real probe against a
 * real agent calls a live model; automated coverage runs against `tools/stub-acp-agent` instead
 * (DC-0013).
 */

/** Where a probe got to before it failed. */
export type ProbeStage = "spawn" | "initialize" | "session" | "prompt";

export interface ProbeAuthMethod {
  readonly id: string;
  readonly name: string;
}

export type ProbeResult =
  | {
      ok: true;
      protocolVersion: number;
      /** `null` when the agent does not advertise one — not advertised is not a failure (AC-6). */
      agentInfo: { name: string; version: string } | null;
      agentCapabilities: Record<string, unknown> | null;
      authMethods: ProbeAuthMethod[];
      sessionId: string;
      reply: string;
      stopReason: string;
      stderr: string;
    }
  | {
      ok: false;
      stage: ProbeStage;
      /**
       * `command_not_found` · `spawn_failed` · `exited` · `timeout` · `auth_required` ·
       * `protocol_error` · `failed`. Stable enough for the UI to branch on.
       */
      code: string;
      message: string;
      stderr: string;
      /** Populated when the agent got far enough to advertise them — matters for `auth_required`. */
      authMethods: ProbeAuthMethod[];
    };

export interface ProbeOptions {
  /** Absolute path the session runs against. */
  readonly cwd: string;
  readonly prompt?: string;
  readonly timeoutMs?: number;
  readonly clientVersion?: string;
}

/** JSON-RPC code an agent returns from `session/new` when it has not been logged in. */
const AUTH_REQUIRED = -32000;
const DEFAULT_PROMPT = "Reply with exactly: ok";
const DEFAULT_TIMEOUT_MS = 30_000;
/** Enough to see a stack trace or a missing-module error, not enough to blow up an IPC payload. */
const STDERR_LIMIT = 8_000;
/** How long the failure path waits for `exit` after the stream error it caused. */
const EXIT_GRACE_MS = 250;

/** Written out rather than as constructor parameter properties, which are not erasable syntax. */
class ProbeFailure extends Error {
  readonly stage: ProbeStage;
  readonly code: string;

  constructor(stage: ProbeStage, code: string, message: string) {
    super(message);
    this.name = "ProbeFailure";
    this.stage = stage;
    this.code = code;
  }
}

export async function probeHarness(spec: LaunchSpec, options: ProbeOptions): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let stderr = "";
  let stage: ProbeStage = "spawn";
  let authMethods: ProbeAuthMethod[] = [];

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(spec.command, [...spec.args], {
      cwd: spec.cwd ?? options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (cause) {
    // Synchronous throws are rare — bad argv shapes, mostly. ENOENT arrives on the `error` event.
    return {
      ok: false,
      stage: "spawn",
      code: "spawn_failed",
      message: describe(cause),
      stderr: "",
      authMethods: [],
    };
  }

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < STDERR_LIMIT) stderr = (stderr + chunk).slice(0, STDERR_LIMIT);
  });

  // A command that is not on PATH never starts at all, so it never produces a protocol error to
  // read. That arrives on `error`, and is raced against the ACP flow.
  const died = new Promise<never>((_resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(
        error.code === "ENOENT"
          ? new ProbeFailure("spawn", "command_not_found", `${spec.command} is not on PATH`)
          : new ProbeFailure("spawn", "spawn_failed", describe(error)),
      );
    });
  });
  // `died` is raced, not always awaited; without this a spawn error is an unhandled rejection.
  died.catch(() => undefined);

  // Exit is *not* raced. A process that dies closes its stdout first, so the SDK's "the stream
  // ended" rejection always beats the `exit` event by a tick — racing would just report the symptom.
  // Instead the failure path asks, briefly, whether the child is dead, and lets that outrank it.
  const exited = new Promise<string>((resolve) => {
    child.on("exit", (code, signal) =>
      resolve(signal ? `on ${signal}` : `with code ${code ?? "unknown"}`),
    );
  });

  const timer = new Promise<never>((_resolve, reject) => {
    setTimeout(
      () => reject(new ProbeFailure(stage, "timeout", `no response within ${timeoutMs}ms`)),
      timeoutMs,
    ).unref?.();
  });

  const run = client({ name: "aiBuildOS" })
    // A probe must not touch the user's machine: no capabilities are advertised, and any permission
    // the agent asks for anyway is declined (ST-0002#AC-2).
    .onRequest(methods.client.session.requestPermission, () => ({
      outcome: { outcome: "cancelled" as const },
    }))
    .connectWith(
      ndJsonStream(
        // (writable → the agent's stdin, readable ← the agent's stdout). The SDK's own example
        // names these locals the other way round; the argument order here is the correct one.
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
      async (ctx) => {
        stage = "initialize";
        const init = await ctx.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "aiBuildOS", version: options.clientVersion ?? "0.0.0" },
          clientCapabilities: {},
        });
        authMethods = (init.authMethods ?? []).map((method) => ({
          id: method.id,
          name: method.name,
        }));

        stage = "session";
        return await ctx.buildSession(options.cwd).withSession(async (session) => {
          stage = "prompt";
          let reply = "";

          const prompted = session.prompt(options.prompt ?? DEFAULT_PROMPT);
          // `prompt()` queues the stop message only when it *resolves*. If it rejects, draining
          // updates would block until the timeout, so the rejection is raced in — and because it is
          // handled here, it is never an unhandled rejection either.
          const rejection = prompted.then<never, never>(
            () => new Promise<never>(() => undefined),
            (cause) => Promise.reject(cause),
          );

          const drain = (async () => {
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") return message;
              if (
                message.update.sessionUpdate === "agent_message_chunk" &&
                message.update.content.type === "text"
              ) {
                reply += message.update.content.text;
              }
            }
          })();

          const stop = await Promise.race([drain, rejection]);
          return {
            protocolVersion: init.protocolVersion,
            agentInfo: init.agentInfo ?? null,
            agentCapabilities: (init.agentCapabilities ?? null) as Record<string, unknown> | null,
            sessionId: session.sessionId,
            reply,
            stopReason: stop.stopReason as string,
          };
        });
      },
    );

  try {
    const result = await Promise.race([run, died, timer]);
    return { ok: true, ...result, authMethods, stderr };
  } catch (cause) {
    // A process that died takes the blame for whatever its closed stream then threw. `exit` lands a
    // tick or two after the stream error, so give it that long — but no longer.
    const how = await Promise.race([exited, sleep(EXIT_GRACE_MS).then(() => null)]);
    return { ok: false, ...classify(cause, stage, how), stderr, authMethods };
  } finally {
    run.catch(() => undefined);
    child.kill();
  }
}

function classify(
  cause: unknown,
  stage: ProbeStage,
  /** How the child exited, if it did — `"with code 3"`, `"on SIGTERM"` — or `null` if still alive. */
  exited: string | null,
): { stage: ProbeStage; code: string; message: string } {
  if (cause instanceof ProbeFailure) {
    return { stage: cause.stage, code: cause.code, message: cause.message };
  }
  if (cause instanceof RequestError) {
    // Needing to log in is a working harness in the wrong state, not a broken one (AC-7).
    const code = cause.code === AUTH_REQUIRED ? "auth_required" : "protocol_error";
    return { stage, code, message: cause.message };
  }
  if (exited !== null) {
    return {
      stage,
      code: "exited",
      message: `the agent exited ${exited} before the probe finished`,
    };
  }
  return { stage, code: "failed", message: describe(cause) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

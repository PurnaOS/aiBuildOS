import { z } from "zod";

/**
 * Zod compiles parsers with `new Function` by default. Electron's preload context — and the renderer
 * under this app's CSP — disallow code generation from strings, so the compiled parser throws
 * "Code generation from strings disallowed for this context" the first time a channel is validated
 * on the client side.
 *
 * `jitless` swaps in the interpreted path, which works everywhere. IPC payloads are small; the
 * difference is not measurable, and it is what keeps validation running on *both* ends of the
 * boundary rather than only in main (DC-0006).
 */
z.config({ jitless: true });

/**
 * The IPC contract: the single source of truth for the renderer↔main boundary (DC-0006).
 *
 * Every channel declares a Zod schema for its request and its response. The router validates on the
 * way in, the client's types are derived from here, so a handler cannot drift from its channel.
 */
/**
 * One configured coding agent. No credentials: a harness inherits the application's environment, so
 * an agent CLI already logged in on the machine works unchanged (DC-0011 arrives separately).
 */
export const HarnessSchema = z.object({
  id: z.string(),
  displayName: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().optional(),
});

const AuthMethodSchema = z.object({ id: z.string(), name: z.string() });

/**
 * The outcome of testing a harness. Mirrors `ProbeResult` in `@aibuildos/acp`; the two are held
 * together by the router's `Handlers` type, which will not compile if the probe drifts from the
 * wire.
 */
export const ProbeResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    protocolVersion: z.number(),
    agentInfo: z.object({ name: z.string(), version: z.string() }).nullable(),
    agentCapabilities: z.record(z.string(), z.unknown()).nullable(),
    authMethods: z.array(AuthMethodSchema),
    sessionId: z.string(),
    reply: z.string(),
    stopReason: z.string(),
    stderr: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    stage: z.enum(["spawn", "initialize", "session", "prompt"]),
    code: z.string(),
    message: z.string(),
    stderr: z.string(),
    authMethods: z.array(AuthMethodSchema),
  }),
]);

export const channels = {
  /** Runtime identity of the host process — the smallest useful real channel. */
  "app:info": {
    request: z.void(),
    response: z.object({
      name: z.string(),
      version: z.string(),
      /** Which runtime is actually executing the main process. See AR-0001. */
      runtime: z.object({
        node: z.string(),
        electron: z.string().optional(),
        chrome: z.string().optional(),
      }),
    }),
  },

  /** Every configured harness (RQ-0001#AC-1). */
  "harness:list": {
    request: z.void(),
    response: z.array(HarnessSchema),
  },
  /** Upsert: no `id` creates one, an existing `id` replaces it (RQ-0001#AC-2). */
  "harness:save": {
    request: HarnessSchema.partial({ id: true }),
    response: HarnessSchema,
  },
  "harness:remove": {
    request: z.object({ id: z.string() }),
    response: z.void(),
  },
  /**
   * Spawn the harness and run a full ACP round trip (RQ-0001#AC-5). Slow by nature — a real agent
   * is a subprocess and a model call — so the renderer treats this as a long-running invoke.
   */
  "harness:test": {
    request: z.object({ id: z.string() }),
    response: ProbeResultSchema,
  },
} as const satisfies Record<string, ChannelDefinition>;

export interface ChannelDefinition {
  readonly request: z.ZodType;
  readonly response: z.ZodType;
}

export type ChannelName = keyof typeof channels;

export type ChannelRequest<C extends ChannelName> = z.infer<(typeof channels)[C]["request"]>;
export type ChannelResponse<C extends ChannelName> = z.infer<(typeof channels)[C]["response"]>;

export const CHANNEL_NAMES = Object.keys(channels) as ChannelName[];

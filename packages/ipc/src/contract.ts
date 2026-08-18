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
} as const satisfies Record<string, ChannelDefinition>;

export interface ChannelDefinition {
  readonly request: z.ZodType;
  readonly response: z.ZodType;
}

export type ChannelName = keyof typeof channels;

export type ChannelRequest<C extends ChannelName> = z.infer<(typeof channels)[C]["request"]>;
export type ChannelResponse<C extends ChannelName> = z.infer<(typeof channels)[C]["response"]>;

export const CHANNEL_NAMES = Object.keys(channels) as ChannelName[];

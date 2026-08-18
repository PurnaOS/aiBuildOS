import {
  type ChannelName,
  type ChannelRequest,
  type ChannelResponse,
  channels,
} from "./contract.js";

/**
 * Structural interfaces, not Electron's concrete types.
 *
 * This is the whole reason the router is in-house (DC-0006): depending only on the shape means the
 * router — the part of the app most worth testing — unit-tests against an in-memory fake with no
 * Electron runtime at all.
 */
export interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void;
}

export interface IpcRendererLike {
  invoke(channel: string, payload: unknown): Promise<unknown>;
}

export type Handlers = {
  [C in ChannelName]: (
    request: ChannelRequest<C>,
  ) => ChannelResponse<C> | Promise<ChannelResponse<C>>;
};

export class IpcContractError extends Error {
  constructor(
    readonly channel: string,
    readonly direction: "request" | "response",
    cause: unknown,
  ) {
    super(`IPC ${direction} for "${channel}" did not match its contract`, { cause });
    this.name = "IpcContractError";
  }
}

/** Bind every contract channel to a handler, validating both directions. */
export function createRouter(ipcMain: IpcMainLike, handlers: Handlers): void {
  for (const name of Object.keys(channels) as ChannelName[]) {
    const definition = channels[name];
    const handler = handlers[name] as (request: unknown) => unknown;

    ipcMain.handle(name, async (_event, payload) => {
      let request: unknown;
      try {
        request = definition.request.parse(payload);
      } catch (cause) {
        throw new IpcContractError(name, "request", cause);
      }

      const result = await handler(request);

      try {
        return definition.response.parse(result);
      } catch (cause) {
        throw new IpcContractError(name, "response", cause);
      }
    });
  }
}

export interface IpcClient {
  invoke<C extends ChannelName>(
    channel: C,
    request: ChannelRequest<C>,
  ): Promise<ChannelResponse<C>>;
}

/** The typed surface the preload script exposes across the contextBridge. */
export function createClient(ipcRenderer: IpcRendererLike): IpcClient {
  return {
    async invoke(channel, request) {
      const raw = await ipcRenderer.invoke(channel, request);
      try {
        return channels[channel].response.parse(raw) as never;
      } catch (cause) {
        throw new IpcContractError(channel, "response", cause);
      }
    },
  };
}

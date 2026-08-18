import { describe, expect, it } from "vitest";
import {
  createClient,
  createRouter,
  type Handlers,
  IpcContractError,
  type IpcMainLike,
  type IpcRendererLike,
} from "./router.js";

/**
 * An in-memory stand-in for Electron's ipcMain/ipcRenderer pair. It exists to prove the point of
 * DC-0006: the boundary is fully testable without launching Electron.
 */
function createFakeIpc(): IpcMainLike & IpcRendererLike {
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
  return {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
    async invoke(channel, payload) {
      const listener = handlers.get(channel);
      if (!listener) throw new Error(`no handler registered for "${channel}"`);
      return await listener({}, payload);
    },
  };
}

/**
 * These tests exercise the router's mechanism, not the channel roster, so they register only the
 * channel under test. `createRouter` binds every channel but calls none of them until invoked, so a
 * partial map is safe here — and it keeps adding a channel from churning this file.
 */
const only = (handlers: Partial<Handlers>): Handlers => handlers as Handlers;

const validHandlers = only({
  "app:info": () => ({ name: "aibuildos", version: "0.1.0", runtime: { node: "22.0.0" } }),
});

describe("ipc router", () => {
  it("round-trips a contract channel through a typed client", async () => {
    const ipc = createFakeIpc();
    createRouter(ipc, validHandlers);

    const info = await createClient(ipc).invoke("app:info", undefined);

    expect(info.name).toBe("aibuildos");
    expect(info.runtime.node).toBe("22.0.0");
  });

  it("rejects a response that does not match the contract", async () => {
    const ipc = createFakeIpc();
    createRouter(ipc, only({ "app:info": () => ({ name: "aibuildos" }) as never }));

    await expect(createClient(ipc).invoke("app:info", undefined)).rejects.toThrow(IpcContractError);
  });

  it("rejects a request that does not match the contract", async () => {
    const ipc = createFakeIpc();
    createRouter(ipc, validHandlers);

    await expect(ipc.invoke("app:info", { unexpected: true })).rejects.toThrow(IpcContractError);
  });
});

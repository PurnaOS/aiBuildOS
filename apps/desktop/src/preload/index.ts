import { createClient, createSubscriber, type IpcBridge } from "@aibuildos/ipc";
import { contextBridge, ipcRenderer } from "electron";

/**
 * The entire surface the renderer gets. Nothing else crosses (DC-0006).
 *
 * Two halves: `invoke` for anything with an answer, and `subscribe` for the one-way narration a live
 * agent session produces (DC-0017). Both validate against the contract on this side of the boundary.
 */
const bridge: IpcBridge = {
  ...createClient({
    invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  }),
  ...createSubscriber({
    on: (channel, listener) => {
      ipcRenderer.on(channel, listener);
    },
    removeListener: (channel, listener) => {
      ipcRenderer.removeListener(channel, listener);
    },
  }),
};

contextBridge.exposeInMainWorld("aibuildos", bridge);

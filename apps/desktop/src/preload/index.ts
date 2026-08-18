import { createClient, type IpcClient } from "@aibuildos/ipc";
import { contextBridge, ipcRenderer } from "electron";

/**
 * The entire surface the renderer gets. Nothing else crosses (DC-0006).
 */
const client: IpcClient = createClient({
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
});

contextBridge.exposeInMainWorld("aibuildos", client);

import { createRouter, type Handlers, type IpcMainLike } from "@aibuildos/ipc";
import { app } from "electron";

/**
 * Bind the IPC contract to Electron's ipcMain.
 *
 * `createRouter` takes a structural `IpcMainLike`, so this file is the only place that knows about
 * Electron at all — which is what lets the router itself be tested without it (DC-0006).
 */
const handlers: Handlers = {
  "app:info": () => ({
    name: "aiBuildOS",
    version: app.getVersion(),
    runtime: {
      node: process.versions.node,
      ...(process.versions.electron === undefined ? {} : { electron: process.versions.electron }),
      ...(process.versions.chrome === undefined ? {} : { chrome: process.versions.chrome }),
    },
  }),
};

export function registerIpc(ipcMain: IpcMainLike): void {
  createRouter(ipcMain, handlers);
}

import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { registerIpc } from "./ipc.js";

/**
 * Electron main. Runs on Electron's bundled Node, never on Bun (AR-0001, DC-0002).
 *
 * This is the shell only: a window, and the IPC boundary. No product behaviour lives here yet.
 */
function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    // Three panes need the room: at 1280 the conversation is squeezed between two rails
    // (ST-0011#AC-6).
    width: 1440,
    height: 900,
    show: false,
    title: "aiBuildOS",
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.mjs", import.meta.url)),
      // The renderer gets no Node integration. Everything privileged crosses the typed IPC
      // boundary instead (DC-0006).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.on("ready-to-show", () => window.show());

  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));

  return window;
}

void app.whenReady().then(() => {
  // The sender is resolved per emit, not captured: handlers are registered before any window exists,
  // and the window can be replaced while the application runs.
  const sessions = registerIpc(
    ipcMain,
    () => BrowserWindow.getAllWindows()[0]?.webContents ?? null,
  );
  createWindow();

  // No agent outlives the application that started it. `before-quit` rather than
  // `window-all-closed`, because on macOS closing the window does not quit.
  app.on("before-quit", () => {
    void sessions.closeAll();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

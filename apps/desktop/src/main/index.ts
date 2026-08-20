import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { killChecks } from "./checks.js";
import { registerIpc } from "./ipc.js";
import { commandTarget, installMenu } from "./menu.js";
import { loadSettings, settingsFile } from "./settings.js";

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
  // Before the window exists, so the chosen appearance is in force on the first frame rather than
  // applied as a flash of the wrong one afterwards (RQ-0007#AC-4). `themeSource` is what makes
  // `prefers-color-scheme` answer differently in the renderer, which is how every `dark:` utility and
  // the conversation's own palette follow without a line of renderer code knowing about the setting.
  nativeTheme.themeSource = loadSettings(settingsFile(app.getPath("userData"))).appearance;

  // The sender is resolved per emit, not captured: handlers are registered before any window exists,
  // and the window can be replaced while the application runs.
  const sessions = registerIpc(
    ipcMain,
    () => BrowserWindow.getAllWindows()[0]?.webContents ?? null,
  );

  // What a command *means* is the renderer's business — only it knows what is on screen — so the menu
  // says what happened and nothing more.
  installMenu((command) =>
    commandTarget(
      BrowserWindow.getAllWindows(),
      BrowserWindow.getFocusedWindow(),
    )?.webContents.send("app:command", { command }),
  );

  createWindow();

  // No agent outlives the application that started it. `before-quit` rather than
  // `window-all-closed`, because on macOS closing the window does not quit.
  app.on("before-quit", () => {
    void sessions.closeAll();
    killChecks();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

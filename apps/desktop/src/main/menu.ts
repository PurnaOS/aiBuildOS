import { type BrowserWindow, Menu } from "electron";

/**
 * The application's menu (RQ-0008#AC-2, AC-7).
 *
 * Setting a menu at all is a decision with a cost: an application that sets none inherits the
 * platform's, and gets copy, paste, undo, select-all, close and quit for nothing. Setting one to add
 * ⌘S means putting all of those back by hand, and forgetting any of them is a working shortcut
 * traded for a new one.
 *
 * So this is the platform's own roles, plus exactly one item of ours. The accelerator is written as
 * `CmdOrCtrl` and Electron resolves it per platform — a key handler in the renderer would have to
 * guess at that, and would guess wrong somewhere.
 */
export function installMenu(send: (command: "save" | "toggle-sidebar") => void): void {
  const mac = process.platform === "darwin";

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(mac ? [{ role: "appMenu" as const }] : []),
      {
        label: "File",
        submenu: [
          {
            // Identified so a test can invoke the item itself: a synthetic key press cannot fire a
            // native accelerator, so what is verified is everything the accelerator is attached to.
            id: "save",
            label: "Save",
            accelerator: "CmdOrCtrl+S",
            click: () => send("save"),
          },
          { type: "separator" as const },
          mac ? { role: "close" as const } : { role: "quit" as const },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          {
            id: "toggle-sidebar",
            label: "Sidebar",
            accelerator: "CmdOrCtrl+B",
            click: () => send("toggle-sidebar"),
          },
          { type: "separator" as const },
          { role: "reload" as const },
          { role: "toggleDevTools" as const },
          { type: "separator" as const },
          { role: "resetZoom" as const },
          { role: "zoomIn" as const },
          { role: "zoomOut" as const },
          { type: "separator" as const },
          { role: "togglefullscreen" as const },
        ],
      },
      { role: "windowMenu" },
    ]),
  );
}

/** The window a command is meant for: the focused one, or the only one there is. */
export function commandTarget(
  windows: BrowserWindow[],
  focused: BrowserWindow | null,
): BrowserWindow | null {
  return focused ?? windows[0] ?? null;
}

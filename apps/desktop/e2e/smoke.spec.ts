import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The one end-to-end test the bootstrap ships: the built app launches, the renderer mounts, and the
 * typed IPC boundary answers. Runs against the *build output* (DC-0013), so `build` comes first.
 */
test("the built app launches and the IPC boundary answers", async () => {
  const app = await electron.launch({ args: ["."], cwd: appRoot });
  const window = await app.firstWindow();

  await expect(window.getByTestId("title")).toHaveText("aiBuildOS");

  // `app:info` round-trips through preload → ipcMain → the Zod-validated router and back.
  await expect(window.getByTestId("runtime")).toContainText(".");
  await expect(window.getByTestId("sidebar")).toBeVisible();

  await app.close();
});

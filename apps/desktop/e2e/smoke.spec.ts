import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * The one end-to-end test the bootstrap ships: the built app launches, the renderer mounts, and the
 * typed IPC boundary answers. Runs against the *build output* (DC-0013), so `build` comes first.
 *
 * Every config file is pointed at a temp directory — a developer's own settings (a collapsed
 * sidebar, say) must never decide whether the suite passes.
 */
test("the built app launches and the IPC boundary answers", async () => {
  const config = mkdtempSync(join(tmpdir(), "smoke-config-"));
  const app = await electron.launch({
    args: ["."],
    cwd: appRoot,
    env: {
      ...process.env,
      AIBUILDOS_PROJECTS_FILE: join(config, "projects.json"),
      AIBUILDOS_HARNESSES_FILE: join(config, "harnesses.json"),
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
    },
  });
  const window = await app.firstWindow();

  await expect(window.getByTestId("title")).toHaveText("aiBuildOS");

  // `app:info` round-trips through preload → ipcMain → the Zod-validated router and back.
  await expect(window.getByTestId("runtime")).toContainText(".");
  await expect(window.getByTestId("sidebar")).toBeVisible();

  await app.close();
});

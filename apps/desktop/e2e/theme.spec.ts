import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/**
 * TC-0028. The conversation is drawn in the application's palette.
 *
 * Against the rendered surface, not the stylesheet: the defect this covers is a cascade one, where
 * the declarations are present and lose to the library's own.
 */
const DARK_GROUND = "rgb(10, 10, 10)";
const LIGHT_GROUND = "rgb(255, 255, 255)";

test("follows the system appearance, in this application's neutrals", async () => {
  const config = mkdtempSync(join(tmpdir(), "theme-config-"));
  const work = mkdtempSync(join(tmpdir(), "theme-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub],
      },
    ]),
  );
  writeFileSync(
    join(config, "projects.json"),
    JSON.stringify([{ id: "p1", name: "demo", path: work, lastOpened: null }]),
  );

  const app = await electron.launch({
    args: ["."],
    cwd: appRoot,
    env: {
      ...process.env,
      AIBUILDOS_PROJECTS_FILE: join(config, "projects.json"),
      AIBUILDOS_HARNESSES_FILE: join(config, "harnesses.json"),
    },
  });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  const surface = w.locator(".copilotKitMessages");
  await surface.waitFor();

  await w.emulateMedia({ colorScheme: "dark" });
  await expect(surface).toHaveCSS("background-color", DARK_GROUND);
  await expect(surface).toHaveCSS("color", "rgb(245, 245, 245)");

  // A fix that merely forced dark would be the same defect pointing the other way.
  await w.emulateMedia({ colorScheme: "light" });
  await expect(surface).toHaveCSS("background-color", LIGHT_GROUND);
  await expect(surface).toHaveCSS("color", "rgb(23, 23, 23)");

  // Nothing on the document says which appearance is in force; the media query is the only authority.
  const root = w.locator("html");
  expect(await root.getAttribute("class")).toBe(null);
  expect(await root.getAttribute("data-theme")).toBe(null);

  await app.close();
});

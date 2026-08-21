import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * TC-0061. The supervision level is visible where sessions start, hands-off answers a permission
 * request without a press and says so on the transcript's own card, and an ask still waits for a
 * person even at hands-off — because it is renderer-detected message content this setting never
 * touches, by construction (RQ-0022#AC-4).
 */
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

async function open(mode: string): Promise<{ app: ElectronApplication; w: Page }> {
  const config = mkdtempSync(join(tmpdir(), "supervision-config-"));
  const work = mkdtempSync(join(tmpdir(), "supervision-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, `--mode=${mode}`],
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
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
    },
  });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  return { app, w };
}

async function prompt(w: Page, text: string): Promise<void> {
  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill(text);
  await w.keyboard.press("Enter");
}

test("the control is visible where sessions start, defaulting to closest", async () => {
  const { app, w } = await open("permission");

  await expect(w.getByTestId("supervision")).toBeVisible();
  await expect(w.getByTestId("supervision")).toContainText("closest");

  await app.close();
});

test("hands-off answers a permission request without a press, and the card says so", async () => {
  const { app, w } = await open("permission");

  await w.getByTestId("supervision").click();
  await expect(w.getByTestId("supervision")).toContainText("hands-off");

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  await prompt(w, "please run the tests");

  // The card is up, saying the allow was automatic — and, now that it is up, never carrying a
  // button for a decision that was already made on nobody's click.
  await expect(w.getByTestId("permission-automatic")).toBeVisible({ timeout: 15000 });
  await expect(w.getByTestId("permission")).toContainText("automatically");
  await expect(w.locator('[data-testid^="permission-allow"]')).toHaveCount(0);

  await app.close();
});

test("an ask still waits for a person, even at hands-off", async () => {
  const { app, w } = await open("question");

  await w.getByTestId("supervision").click();
  await expect(w.getByTestId("supervision")).toContainText("hands-off");

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  await prompt(w, "go ahead");

  // The ask card is on screen, waiting — answered by nobody, because hands-off never reaches it.
  await expect(w.getByTestId("question-card")).toBeVisible({ timeout: 15000 });
  await expect(w.getByTestId("question-chosen")).toHaveCount(0);

  await app.close();
});

/**
 * TC-0108. RQ-0042#AC-2 to AC-4 through the running application, against the stub agent's real
 * two-MODE collision: its own "Mode" config option sits beside the ACP session's own mode control.
 */
test("the popover disambiguates a name collision by origin, and hands-off echoes on the trigger", async () => {
  const { app, w } = await open("controls");

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  await w.getByTestId("agent-popover-trigger").click();
  const popover = w.getByTestId("agent-popover");

  // Both entries render, disambiguated by their group headings rather than merged on the name
  // they share.
  await expect(popover).toContainText("Session");
  await expect(popover).toContainText("Agent options — Stub");
  await expect(popover.getByTestId("control-mode")).toContainText("Mode");
  await expect(popover.getByTestId("control-style")).toContainText("Mode");

  // Supervision works inside the popover exactly as it did on its own, same testid.
  await expect(popover.getByTestId("supervision")).toContainText("closest");
  await popover.getByTestId("supervision").click();
  await expect(popover.getByTestId("supervision")).toContainText("hands-off");

  // Closed, the trigger still carries the amber echo — readable without opening anything.
  await w.keyboard.press("Escape");
  const trigger = w.getByTestId("agent-popover-trigger");
  await expect(trigger).toContainText("hands-off");

  await app.close();
});

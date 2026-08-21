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

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/**
 * TC-0052. A tap answers the agent, and typing answers it too.
 *
 * Against the stub agent's `--mode=question`: every odd prompt asks "Which colour?" with Red/Blue
 * options, in a fresh card; every even prompt echoes back whatever answer arrived — proof on the
 * transcript both of what a tap sent and of what the agent received.
 */
async function open(): Promise<{ app: ElectronApplication; w: Page }> {
  const config = mkdtempSync(join(tmpdir(), "asks-config-"));
  const work = mkdtempSync(join(tmpdir(), "asks-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=question"],
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
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });
  return { app, w };
}

async function sendPrompt(w: Page, text: string): Promise<void> {
  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill(text);
  await w.keyboard.press("Enter");
}

test("a tap answers the agent, and typing answers it too", async () => {
  const { app, w } = await open();
  const surface = w.locator(".copilotKitMessages");

  // Step 1 (AC-1): the stub's first, odd turn asks — a card offering exactly its own wording and
  // options. Cards from earlier turns stay in the transcript (AC-4), so every lookup below is scoped
  // to the most recent one rather than a bare, ambiguous testid.
  await sendPrompt(w, "start");
  const firstCard = w.getByTestId("question-card").last();
  await expect(firstCard).toContainText("Which colour?");
  await expect(firstCard.getByTestId("question-option-red")).toHaveText("Red");
  await expect(firstCard.getByTestId("question-option-blue")).toHaveText("Blue");
  await expect(firstCard.locator('[data-testid^="question-option-"]')).toHaveCount(2);

  // Step 2 (AC-2): tapping sends the option's label as an ordinary prompt, and the card marks what
  // was chosen.
  await firstCard.getByTestId("question-option-red").click();
  await expect(w.locator(".copilotKitUserMessage").last()).toHaveText("Red");
  await expect(surface).toContainText("You answered: Red", { timeout: 20000 });
  await expect(firstCard.getByTestId("question-chosen")).toHaveText("You chose: Red");

  // Step 3 (AC-3): a second question, answered by typing — the composer is the same free-text path
  // beside the card, and it reaches the agent the same way a tap does.
  await sendPrompt(w, "again");
  const secondCard = w.getByTestId("question-card").last();
  await expect(secondCard).toContainText("Which colour?");
  await sendPrompt(w, "Green");
  await expect(w.locator(".copilotKitUserMessage").last()).toHaveText("Green");
  await expect(surface).toContainText("You answered: Green", { timeout: 20000 });

  // Step 4 (AC-4): a third question, left unanswered — the conversation stays usable and the card
  // stays exactly where it landed.
  await sendPrompt(w, "again");
  const thirdCard = w.getByTestId("question-card").last();
  await expect(thirdCard).toContainText("Which colour?");
  const composer = w.locator("textarea, [contenteditable=true]").first();
  await expect(composer).toBeEditable();
  await expect(thirdCard).toBeVisible();

  await app.close();
});

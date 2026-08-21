import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/**
 * TC-0021. Controls come from the agent, and the agent confirms every change.
 *
 * TC-0123 and TC-0124 (RQ-0051) live here too: `--mode=controls` is the only stub mode that
 * advertises commands at all, so the composer-menu half of this behaviour cannot be exercised from
 * `playbooks.spec.ts`, where TC-0124's record binds it. Two of TC-0123's clauses — a command
 * advertised *mid-session* appearing without a restart, and a withdrawn one disappearing from an
 * open menu — have no fixture yet: today's stub advertises once, at `session/new`, and never again.
 * They arrive with ST-0069's declared dependency, ST-0068, whose stub re-advertises across turns.
 */
async function open(mode: string) {
  const config = mkdtempSync(join(tmpdir(), "ctl-config-"));
  const work = mkdtempSync(join(tmpdir(), "ctl-work-"));
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
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });
  return { app, w };
}

test("shows what the agent offers, and follows the agent when it changes", async () => {
  const { app, w } = await open("controls");

  // RQ-0042: every agent setting lives in one popover now, behind its trigger.
  await w.getByTestId("agent-popover-trigger").click();
  const popover = w.getByTestId("agent-popover");
  await expect(popover.getByTestId("control-mode")).toContainText("Plan");
  await expect(popover.getByTestId("control-model")).toContainText("Sonnet");
  await expect(popover.getByTestId("control-thought_level")).toContainText("Think");

  // Changing asks the agent; the chip follows the agent's own confirmation.
  await popover.getByTestId("control-model").click();
  await popover.getByTestId("control-model-opus").click();
  await expect(popover.getByTestId("control-model")).toContainText("Opus");

  await popover.getByTestId("control-mode").click();
  await popover.getByTestId("control-mode-code").click();
  await expect(popover.getByTestId("control-mode")).toContainText("Code");

  await app.close();
});

/**
 * TC-0123 (RQ-0051#AC-1). What the harness says it can do is offered where messages are composed —
 * beside the playbooks, in its own section, under a heading naming the harness it came from.
 */
test("offers the harness's own commands beside the playbooks, under its name", async () => {
  const { app, w } = await open("controls");

  await w.getByTestId("composer-menu-trigger").click();
  const menu = w.getByTestId("composer-menu");

  // Two origins, two headings — never one interleaved list. This fixture's project has no docs
  // bundle, so the Playbooks section is the seed offer; the section is what matters here.
  await expect(menu).toContainText("Playbooks");
  await expect(menu).toContainText("Commands — Stub");

  // The harness's own name and its own description, verbatim.
  await expect(menu.getByTestId("command-review")).toContainText("/review");
  await expect(menu.getByTestId("command-review")).toContainText("Review the working tree");

  await app.close();
});

/**
 * TC-0124 (RQ-0051#AC-2). Invoking sends — the text goes over the wire rather than being typed into
 * the composer for the person to send — and the transcript draws it as RQ-0031's command card
 * rather than as an ordinary prose bubble.
 *
 * The wire half is only half-proven here: `--mode=controls` does not echo its prompts back yet, so
 * what this asserts is the text the application sent, not the text the agent received. ST-0068's
 * stub fixture (controls echoes, and re-advertises across turns) is what closes that.
 */
test("invoking a command sends it, and the transcript reads it as a command", async () => {
  const { app, w } = await open("controls");

  await w.getByTestId("composer-menu-trigger").click();
  await w.getByTestId("command-review").click();

  // No Enter, no typing: the press itself is the invocation, and the menu closes behind it.
  await expect(w.getByTestId("composer-menu")).toHaveCount(0);
  await expect(w.getByTestId("composer-textarea")).toHaveValue("");

  const card = w.getByTestId("command-message");
  await expect(card).toBeVisible();
  await expect(card).toContainText("command");
  await expect(card).toContainText("/review");

  await app.close();
});

test("shows nothing at all when the agent advertises nothing", async () => {
  const { app, w } = await open("rich");

  await w.getByTestId("agent-popover-trigger").click();
  const popover = w.getByTestId("agent-popover");

  // Absent, not an empty menu — the difference the design turns on. Supervision still shows: it
  // is not a setting the agent could have offered or withheld.
  await expect(popover.getByTestId("control-mode")).toHaveCount(0);
  await expect(popover).not.toContainText("Agent options");
  await expect(popover.getByTestId("supervision")).toBeVisible();

  await w.keyboard.press("Escape");

  // TC-0123, the same rule one surface over (RQ-0051#AC-3): a session advertising no commands
  // leaves no group behind. The Playbooks section stays — it is where seeding lives.
  await w.getByTestId("composer-menu-trigger").click();
  const menu = w.getByTestId("composer-menu");
  await expect(menu).toContainText("Playbooks");
  await expect(menu).not.toContainText("Commands");
  await expect(menu.getByTestId("command-review")).toHaveCount(0);

  await app.close();
});

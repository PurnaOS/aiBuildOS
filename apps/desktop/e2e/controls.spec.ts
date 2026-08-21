import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IpcBridge } from "@aibuildos/ipc";
import { _electron as electron, expect, type Page, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/**
 * TC-0021. Controls come from the agent, and the agent confirms every change.
 *
 * TC-0123 and TC-0124 (RQ-0051) live here too: `--mode=controls` is the only stub mode that
 * advertises commands at all, so the composer-menu half of this behaviour cannot be exercised from
 * `playbooks.spec.ts`, where TC-0124's record binds it. That mode is also the echo-and-re-advertise
 * fixture ST-0068 built for it: it echoes every prompt back, advertises `review` at `session/new`,
 * gains `ship` on the first turn, and withdraws `review` on the second — so a spec can watch a list
 * move without restarting anything. **Two prompts per launch is the whole budget**; a third turn
 * re-advertises nothing.
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

/**
 * A prompt sent without touching the composer — `session:prompt` on the real preload bridge, the
 * same door `session.spec.ts` and `resume.spec.ts` knock on.
 *
 * Not a convenience. RQ-0051#AC-3 asks for a withdrawal that reaches a menu which is *already open*,
 * and no gesture in this application can send while it is: the composer's menu is a non-modal Radix
 * popover, so a click on the textarea or the send button dismisses it before the keystroke lands.
 * `evaluate` moves no focus and dispatches no pointer event, so the menu stays exactly as the person
 * left it while the agent's turn runs underneath it.
 */
async function promptFromOutsideTheMenu(w: Page, text: string): Promise<void> {
  await w.evaluate(async (message) => {
    const api = (globalThis as unknown as { aibuildos: IpcBridge }).aibuildos;
    const { sessions } = await api.invoke("session:list", {});
    // The workspace's own conversation: no story, no background label.
    const chat = sessions.find((session) => session.storyId === null && session.label === null);
    if (chat === undefined) throw new Error("No chat session is open.");
    // Resolves at end_turn, and the stub re-advertises before it answers — so once this returns,
    // the update has already crossed the boundary.
    await api.invoke("session:prompt", { sessionId: chat.sessionId, text: message });
  }, text);
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
 * TC-0123 (RQ-0051#AC-1 and #AC-3). What the harness says it can do is offered where messages are
 * composed — beside the playbooks, in its own section, under a heading naming the harness it came
 * from — and that offer is *live*: the list follows the agent across turns, in one running app.
 */
test("offers the harness's own commands beside the playbooks, under its name, and follows them live", async () => {
  const { app, w } = await open("controls");

  await w.getByTestId("composer-menu-trigger").click();
  const menu = w.getByTestId("composer-menu");

  // Two origins, two headings — never one interleaved list. This fixture's project has no docs
  // bundle, so the Playbooks section is the seed offer; the section is what matters here.
  await expect(menu).toContainText("Playbooks");
  await expect(menu).toContainText("Commands — Stub");

  // The harness's own name and its own description, verbatim. This assertion is also what makes
  // the next one mean something: the list has demonstrably arrived, so `ship` is absent rather
  // than merely not loaded yet.
  await expect(menu.getByTestId("command-review")).toContainText("/review");
  await expect(menu.getByTestId("command-review")).toContainText("Review the working tree");
  await expect(menu.getByTestId("command-ship")).toHaveCount(0);

  await w.keyboard.press("Escape");

  // AC-3, first half: a command advertised *mid-session* appears, with no restart. One ordinary
  // turn — typed and sent the way anyone sends one — and the stub advertises `ship` alongside
  // `review`. Same app, same session, same menu.
  const surface = w.locator(".copilotKitMessages");
  await w.getByTestId("composer-textarea").fill("hello");
  await w.getByTestId("composer-textarea").press("Enter");
  await expect
    .poll(async () => (await surface.innerText()).split("hello").length - 1, { timeout: 20000 })
    .toBeGreaterThanOrEqual(2);
  // The turn is over, not merely echoing: the next prompt must not race this one.
  await expect(w.getByTestId("copilot-send-button")).toHaveAttribute("aria-label", "Send");

  await w.getByTestId("composer-menu-trigger").click();
  await expect(menu.getByTestId("command-ship")).toContainText("/ship");
  await expect(menu.getByTestId("command-review")).toBeVisible();

  // AC-3, second half, and the clause the record calls out: a withdrawal reaches a menu that is
  // *already open*. Nothing closes it and nothing reopens it — the turn runs underneath it (see
  // `promptFromOutsideTheMenu`), and the entry has to leave on its own.
  await promptFromOutsideTheMenu(w, "again");

  await expect(menu.getByTestId("command-review")).toHaveCount(0);
  // Load-bearing: a closed menu would also report no `review`. `ship` still visible is the proof
  // that the menu never closed and re-rendered in place.
  await expect(menu.getByTestId("command-ship")).toBeVisible();
  await expect(menu).toContainText("Commands — Stub");

  await app.close();
});

/**
 * TC-0124 (RQ-0051#AC-2). Invoking sends — the text goes over the wire rather than being typed into
 * the composer for the person to send — and the transcript draws it as RQ-0031's command card
 * rather than as an ordinary prose bubble.
 *
 * Both halves are proven: `--mode=controls` echoes back exactly the prompt text it received, so the
 * transcript carries `/review` twice — once as the card the application drew, once as the agent
 * repeating what actually arrived. An application that sent the wrong text, or none, shows one.
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

  // What the *agent* got. The composer is empty and the menu is gone, so the second `/review` on
  // the transcript can only have come back over the wire — `/review`, exactly, with nothing
  // decorated onto it.
  const surface = w.locator(".copilotKitMessages");
  await expect
    .poll(async () => (await surface.innerText()).split("/review").length - 1, { timeout: 20000 })
    .toBeGreaterThanOrEqual(2);

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

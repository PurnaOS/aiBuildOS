import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const template = fileURLToPath(new URL("../src/main/okf-template/docs", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/**
 * TC-0045. A pressed playbook says exactly what it sent, in the transcript.
 *
 * Against the stub agent's `--mode=echo`, which replies with exactly the prompt text it received —
 * proof on the transcript both of what a button said it would send and of what actually arrived.
 */
async function open(options: { playbooks?: boolean } = {}): Promise<{
  app: ElectronApplication;
  w: Page;
  work: string;
}> {
  const config = mkdtempSync(join(tmpdir(), "playbooks-config-"));
  const work = mkdtempSync(join(tmpdir(), "playbooks-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);
  cpSync(template, join(work, "docs"), { recursive: true });

  if (options.playbooks === false) {
    // A project this old never had DC-0019's type at all, not merely no artifacts of it yet.
    rmSync(join(work, "docs", "playbooks"), { recursive: true, force: true });
    rmSync(join(work, "docs", "profile", "playbook.md"), { force: true });
  } else {
    // The scaffold template leaves `owner` a token for `fillProject` to fill in; this fixture is not
    // going through `fillProject`, so it fills it in the same way, by hand.
    for (const id of ["pb-0001", "pb-0002", "pb-0003"]) {
      const file = join(work, "docs", "playbooks", `${id}.md`);
      writeFileSync(
        file,
        readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"),
        "utf8",
      );
    }
  }

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=echo"],
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
  return { app, w, work };
}

test("shows the standard playbooks, discloses one before pressing, and sends exactly what was shown", async () => {
  const { app, w, work } = await open();

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  const button = w.getByTestId("playbook-PB-0001");
  await expect(button).toBeVisible();
  await expect(button).toHaveText("Draft requirements from an idea");
  await expect(w.getByTestId("playbook-PB-0002")).toBeVisible();
  await expect(w.getByTestId("playbook-PB-0003")).toBeVisible();

  // AC-3: description, harness and exact text, before anything is pressed. One line from the body,
  // not the whole disclosed text, is what the transcript is checked against below — a chat surface
  // is free to reformat the markdown it is handed, and a single line survives that; the full,
  // exact text is what the ⓘ itself is for.
  const snippet = "Interview me about this idea, one question at a time";
  await w.getByTestId("playbook-info-PB-0001").click();
  const popover = w.getByTestId("playbook-popover-PB-0001");
  await expect(popover).toContainText("Draft requirements from an idea");
  await expect(popover).toContainText("Stub");
  await expect(w.getByTestId("playbook-text-PB-0001")).toContainText(snippet);

  await button.click();

  const surface = w.locator(".copilotKitMessages");
  await expect(surface).toContainText(snippet);
  // `--mode=echo` replies with exactly what it received, so the snippet lands twice: once as the
  // user's own message, once as the agent's reply — proof of what was sent and what arrived.
  await expect
    .poll(async () => (await surface.innerText()).split(snippet).length - 1, { timeout: 20000 })
    .toBeGreaterThanOrEqual(2);

  // AC-4/AC-5: editing the artifact like any other changes the button, with no application change.
  await w.getByTestId("record-open-PB-0001").click();
  await w.getByTestId("artifact-tab").waitFor();
  await w.getByTestId("artifact-body").locator(".cm-content").click();
  await w.keyboard.press("ControlOrMeta+End");
  await w.keyboard.type("\n\nSay hello first.");
  await expect(w.getByTestId("artifact-saved")).toHaveText("saved", { timeout: 15000 });
  expect(readFileSync(join(work, "docs", "playbooks", "pb-0001.md"), "utf8")).toContain(
    "Say hello first.",
  );

  await w.getByTestId("tab-chat").click();
  await w.getByTestId("chat").waitFor();
  await w.getByTestId("playbook-PB-0001").click();
  await expect(surface).toContainText("Say hello first.");

  await app.close();
});

test("a project without playbooks offers to seed them, and seeding produces the buttons", async () => {
  const { app, w } = await open({ playbooks: false });

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  await expect(w.getByTestId("playbook-PB-0001")).toHaveCount(0);
  const seed = w.getByTestId("seed-playbooks");
  await expect(seed).toBeVisible();

  await seed.click();

  await expect(w.getByTestId("playbook-PB-0001")).toBeVisible({ timeout: 15000 });
  await expect(w.getByTestId("playbook-PB-0002")).toBeVisible();
  await expect(w.getByTestId("playbook-PB-0003")).toBeVisible();
  await expect(seed).toHaveCount(0);

  await app.close();
});

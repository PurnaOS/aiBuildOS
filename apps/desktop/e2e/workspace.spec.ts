import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
 * TC-0018 and TC-0019. The workspace: three panes, a tabbed centre, and rails that show the record
 * and the working tree.
 *
 * Against the built application with the harness pointed at the scripted stub (DC-0013).
 */
function artifact(id: string, type: string, title: string, state: string, links = ""): string {
  return [
    "---",
    `type: ${type}`,
    `id: ${id}`,
    `title: "${title}"`,
    `state: ${state}`,
    "owner: srini",
    "provenance: agent",
    "created: 2026-08-19",
    ...(links ? ["links:", links] : []),
    "---",
    "",
    `# ${id} — ${title}`,
    "",
    "## Acceptance criteria",
    "",
    "- [AC-1] It does the thing.",
    "",
  ].join("\n");
}

/** A project with a small bundle, a commit, and a working tree that has something to show. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "aibuildos-ws-"));
  execFileSync("git", ["-C", dir, "init", "--quiet"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);

  mkdirSync(join(dir, "docs", "requirements"), { recursive: true });
  mkdirSync(join(dir, "docs", "user-stories"), { recursive: true });
  mkdirSync(join(dir, "docs", "testing"), { recursive: true });
  writeFileSync(
    join(dir, "docs", "requirements", "rq-0001.md"),
    artifact("RQ-0001", "Requirement", "The thing", "ready"),
  );
  writeFileSync(
    join(dir, "docs", "user-stories", "st-0001.md"),
    artifact("ST-0001", "Story", "Build the thing", "ready", "  implements: [RQ-0001]"),
  );
  writeFileSync(
    join(dir, "docs", "testing", "tc-0001.md"),
    artifact("TC-0001", "TestCase", "Check the thing", "active", "  verifies: [RQ-0001]"),
  );
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), "secret/\n");
  mkdirSync(join(dir, "secret"));
  writeFileSync(join(dir, "secret", "hidden.txt"), "shh\n");

  execFileSync("git", ["-C", dir, "add", "-A"]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "first"]);

  // Something for the Git rail to report: one modified path, one unknown one.
  writeFileSync(join(dir, "tracked.txt"), "two\n");
  writeFileSync(join(dir, "fresh.txt"), "new\n");
  return dir;
}

async function launch(project: string): Promise<{ app: ElectronApplication; w: Page }> {
  const config = mkdtempSync(join(tmpdir(), "aibuildos-ws-config-"));
  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "rich",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=rich"],
      },
    ]),
  );
  writeFileSync(
    join(config, "projects.json"),
    JSON.stringify([{ id: "p1", name: "demo", path: project, lastOpened: null }]),
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
  return { app, w };
}

test("lays out three panes with a tabbed centre and streams a turn", async () => {
  const { app, w } = await launch(makeProject());

  // Three panes (TC-0018).
  await expect(w.getByTestId("record-rail")).toBeVisible();
  await expect(w.getByTestId("files-rail")).toBeVisible();
  await expect(w.getByTestId("tab-strip")).toBeVisible();

  // The conversation is the first tab and cannot be closed.
  await expect(w.getByTestId("tab-chat")).toBeVisible();
  await expect(w.getByTestId("tab-close-chat")).toHaveCount(0);

  // A turn arrives progressively, and its tool call is shown with its status in words.
  await w.getByTestId("start-rich").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });
  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill("do the thing");
  await w.keyboard.press("Enter");

  await expect(w.getByTestId("tool-call")).toBeVisible({ timeout: 15000 });
  await expect(w.getByTestId("tool-call")).toContainText("completed");
  await expect(w.getByTestId("plan")).toBeVisible();

  // Opening a file opens a further tab beside the conversation; opening it again focuses that tab.
  await w.getByTestId("file-row").filter({ hasText: "tracked.txt" }).click();
  await expect(w.getByTestId("tab-tracked.txt")).toBeVisible();
  await expect(w.getByTestId("tab-chat")).toBeVisible();
  const opened = await w.getByTestId("tab-strip").locator("[data-testid^='tab-']").count();
  await w.getByTestId("file-row").filter({ hasText: "tracked.txt" }).click();
  expect(await w.getByTestId("tab-strip").locator("[data-testid^='tab-']").count()).toBe(opened);

  await app.close();
});

test("lists the record with derived links, and the working tree as Git sees it", async () => {
  const { app, w } = await launch(makeProject());

  // The record, grouped by type (TC-0019).
  await expect(w.getByTestId("record-row")).toHaveCount(3);
  await expect(w.getByTestId("record-open-RQ-0001")).toContainText("ready");

  // Expanding a requirement shows the work and the verification, neither of which the requirement
  // itself names — they are derived from links stored the other way.
  await w.getByRole("button", { name: "Expand RQ-0001" }).click();
  const rows = w.getByTestId("record-row").filter({ hasText: "RQ-0001" });
  await expect(rows).toContainText("implemented by");
  await expect(rows).toContainText("ST-0001");
  await expect(rows).toContainText("verified by");
  await expect(rows).toContainText("TC-0001");

  // An ignored path is not listed at all.
  await expect(w.getByTestId("file-row").filter({ hasText: "secret" })).toHaveCount(0);
  await expect(w.getByTestId("file-row").filter({ hasText: "tracked.txt" })).toBeVisible();

  // Git, on its own tab: changes grouped, and history beneath.
  await w.getByTestId("rail-tab-git").click();
  await expect(w.getByTestId("change-row").filter({ hasText: "tracked.txt" })).toBeVisible();
  await expect(w.getByTestId("change-row").filter({ hasText: "fresh.txt" })).toBeVisible();

  // Selecting a change opens its diff in the centre.
  await w.getByTestId("change-row").filter({ hasText: "tracked.txt" }).click();
  await expect(w.getByTestId("diff-tab")).toBeVisible();
  await expect(w.getByTestId("diff-tab")).toContainText("one");
  await expect(w.getByTestId("diff-tab")).toContainText("two");

  await app.close();
});

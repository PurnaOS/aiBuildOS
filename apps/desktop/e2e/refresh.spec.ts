import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const template = fileURLToPath(new URL("../src/main/okf-template/docs", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/**
 * TC-0027. The rails show what the agent and the user just changed.
 *
 * Watched across a turn rather than after a reload: reloading has always worked, and reading once at
 * mount and never again is exactly the defect ([BG-0001](../../../docs/bugs/bg-0001.md)).
 */
const RQ = `---
type: Requirement
id: RQ-0001
title: "Something the agent wrote"
state: draft
owner: srini
provenance: agent
created: 2026-08-19
kind: functional
---

# RQ-0001 — Something the agent wrote

## Acceptance criteria

- [AC-1] It does the thing.
`;

test("picks up what a turn changed, and what the user saves", async () => {
  const config = mkdtempSync(join(tmpdir(), "refresh-config-"));
  const work = mkdtempSync(join(tmpdir(), "refresh-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  cpSync(template, join(work, "docs"), { recursive: true });
  // Committed, so Git reports the new file rather than collapsing a wholly untracked `docs/` to one
  // entry — which would make the change below invisible for a reason that is not the one under test.
  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", [
    "-C",
    work,
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "--quiet",
    "-m",
    "the bundle",
  ]);

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

  // The scaffold's playbooks are the whole record so far; the requirement arrives mid-turn below.
  await expect(w.getByTestId("record-open-PB-0001")).toBeVisible();
  await expect(w.getByTestId("record-open-RQ-0001")).toHaveCount(0);

  // Something already open, so there is a directory that could go stale rather than be read fresh.
  await w.getByTestId("file-row").filter({ hasText: "docs" }).first().click();
  await w.getByTestId("file-row").filter({ hasText: "requirements" }).first().click();
  await expect(w.getByTestId("file-row").filter({ hasText: "README.md" }).first()).toBeVisible();

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  // What the agent does while a turn runs. The end of the turn is when the rails look.
  const index = join(work, "docs/requirements/README.md");
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ);
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | Something the agent wrote | draft | — |\n`,
  );

  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill("please proceed");
  await w.keyboard.press("Enter");
  await expect(w.getByTestId("chat")).toContainText("ok", { timeout: 15000 });

  // The record, without reopening the project.
  await expect(w.getByTestId("record-open-RQ-0001")).toBeVisible({ timeout: 15000 });
  await expect(w.getByTestId("record-empty")).toHaveCount(0);
  // The directory that was already expanded, still expanded, now listing the new file.
  await expect(w.getByTestId("file-row").filter({ hasText: "rq-0001.md" }).first()).toBeVisible();

  // Git sees it too.
  await w.getByTestId("rail-tab-git").click();
  await expect(w.getByTestId("change-row").filter({ hasText: "rq-0001.md" }).first()).toBeVisible();
  await w.getByTestId("rail-tab-files").click();

  // The user's own writing goes stale just as fast as the agent's.
  await w.getByTestId("record-open-RQ-0001").click();
  await w.getByTestId("artifact-state").selectOption("ready");
  await expect(w.getByTestId("artifact-saved")).toHaveText("saved");
  await expect(w.getByTestId("record-row").filter({ hasText: "RQ-0001" })).toContainText("ready");

  await app.close();
});

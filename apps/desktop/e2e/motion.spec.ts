import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
 * TC-0082. Streaming shows on the tab, and what changed says so.
 *
 * Verifies RQ-0030 through the running application against the slow and file-writer stubs.
 */
async function launch(
  work: string,
  harnesses: { id: string; mode: string }[],
): Promise<{ app: ElectronApplication; w: Page }> {
  const config = mkdtempSync(join(tmpdir(), "motion-config-"));
  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify(
      harnesses.map(({ id, mode }) => ({
        id,
        displayName: id,
        command: process.execPath,
        args: ["--experimental-strip-types", stub, `--mode=${mode}`],
      })),
    ),
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
      AIBUILDOS_WORKTREES_ROOT: mkdtempSync(join(tmpdir(), "motion-worktrees-")),
    },
  });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  return { app, w };
}

test("a streaming turn says so on the conversation's tab, and stops when the turn ends", async () => {
  const work = mkdtempSync(join(tmpdir(), "motion-slow-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);

  const { app, w } = await launch(work, [{ id: "h", mode: "slow" }]);

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill("please proceed");
  await w.keyboard.press("Enter");

  // `--mode=slow` streams for ~500ms (20 turns of 25ms each) — asserted right after pressing Enter,
  // the same window autosave.spec.ts already relies on for the same stub.
  await expect(w.getByTestId("tab-working-chat")).toBeVisible();
  await expect(w.getByTestId("tab-working-chat")).toContainText("working");

  // And it stops saying so once the turn ends — never left on past its own truth.
  await expect(w.getByTestId("tab-working-chat")).toHaveCount(0, { timeout: 10000 });

  await app.close();
});

const RQ = `---
type: Requirement
id: RQ-0001
title: "Notes get written"
state: ready
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0001 — Notes get written

## Acceptance criteria

- [AC-1] A note lands in notes.md.
`;

const TC = `---
type: TestCase
id: TC-0001
title: "Notes get written, verified"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: manual
links:
  verifies: [RQ-0001]
---

# TC-0001 — Notes get written, verified

## Steps

1. Check notes.md changed.
`;

const ST = `---
type: Story
id: ST-0001
title: "Write a note"
state: ready
owner: srini
provenance: human
created: 2026-08-19
links:
  implements: [RQ-0001]
  verified_by: [TC-0001]
---

# ST-0001 — Write a note

## Acceptance criteria

- [AC-1] notes.md contains a new line.
`;

test("a Now row reads in plain words with elapsed time, and a worktree row names its own copy", async () => {
  const work = mkdtempSync(join(tmpdir(), "motion-writer-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);

  cpSync(template, join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ);
  writeFileSync(join(work, "docs/testing/tc-0001.md"), TC);
  writeFileSync(join(work, "docs/user-stories/st-0001.md"), ST);
  const rqIndex = join(work, "docs/requirements/README.md");
  writeFileSync(
    rqIndex,
    `${readFileSync(rqIndex, "utf8")}| [RQ-0001](rq-0001.md) | Notes get written | ready | — |\n`,
  );
  const tcIndex = join(work, "docs/testing/README.md");
  writeFileSync(
    tcIndex,
    `${readFileSync(tcIndex, "utf8")}| [TC-0001](tc-0001.md) | Notes get written, verified | draft | [RQ-0001](../requirements/rq-0001.md) |\n`,
  );
  const stIndex = join(work, "docs/user-stories/README.md");
  writeFileSync(
    stIndex,
    `${readFileSync(stIndex, "utf8")}| [ST-0001](st-0001.md) | Write a note | ready | [RQ-0001](../requirements/rq-0001.md) |\n`,
  );
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"), "utf8");
  }
  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", ["-C", work, "commit", "-m", "seed", "--quiet"]);

  const { app, w } = await launch(work, [{ id: "writer", mode: "file-writer" }]);

  // RQ-0045#AC-1, AC-3: Work is its own pinned surface now, not a nested strip view.
  await w.getByTestId("tab-work").click();
  // ST-0044#AC-4: the worktree entries sit behind the Build control's caret, one menu rather than a
  // button per harness — a concurrent lane's change to `WorkBoard`, not this one's.
  await w.getByTestId("board-card-build-menu-ST-0001").click();
  await w.getByTestId("board-card-build-worktree-ST-0001-writer").click();

  // RQ-0044: Now's rows live in the activity dock now, expanded from its collapsed strip.
  await w.getByTestId("dock-toggle").click();
  await expect(w.getByTestId("now-row-ST-0001")).toBeVisible({ timeout: 20000 });

  // AC-4: the row already answers "where are my files" — every build here is a worktree build.
  await expect(w.getByTestId("now-row-worktree-ST-0001")).toContainText("own copy");
  await expect(w.getByTestId("now-row-worktree-ST-0001")).toContainText("aibuildos/st-0001");

  // AC-2: plain words, with elapsed time, once the file-writer's turn has said anything at all.
  await expect(w.getByTestId("now-row-activity-ST-0001")).toBeVisible({ timeout: 15000 });
  await expect(w.getByTestId("now-row-activity-ST-0001")).toContainText(/ago/);

  // No raw protocol vocabulary anywhere in the row — a decent guard, not a proof, but `TEXT_MESSAGE`,
  // `RUN_FINISHED` and friends are all runs of six or more capitals/underscores this rail never
  // shows on purpose.
  const rowText = await w.getByTestId("now-row-ST-0001").innerText();
  expect(rowText).not.toMatch(/[A-Z_]{6,}/);

  await app.close();
});

test("an artifact changed on disk marks its rail row, and opening it clears the mark", async () => {
  const work = mkdtempSync(join(tmpdir(), "motion-changed-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  cpSync(template, join(work, "docs"), { recursive: true });
  const requirementFile = join(work, "docs/requirements/rq-0001.md");
  writeFileSync(requirementFile, RQ.replace("state: ready", "state: draft"));
  const index = join(work, "docs/requirements/README.md");
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | Notes get written | draft | — |\n`,
  );
  // A raw template copy leaves `owner: {{OWNER}}` in the seed playbooks — not valid YAML left
  // unresolved (build.spec.ts's own comment on this exact loop).
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "srini"));
  }

  // No agent is ever started in this test, so no harness needs to answer anything.
  const { app, w } = await launch(work, [{ id: "h", mode: "ok" }]);

  await expect(w.getByTestId("record-open-RQ-0001")).toBeVisible();
  // Nothing has changed relative to the rail's own first read yet.
  await expect(w.getByTestId("record-changed-RQ-0001")).toHaveCount(0);

  // AC-3: a state flip on disk, from outside the application — the test process is the terminal.
  writeFileSync(requirementFile, RQ);
  writeFileSync(
    index,
    readFileSync(index, "utf8").replace(
      "| [RQ-0001](rq-0001.md) | Notes get written | draft | — |",
      "| [RQ-0001](rq-0001.md) | Notes get written | ready | — |",
    ),
  );

  await expect(w.getByTestId("record-changed-RQ-0001")).toHaveText("changed", { timeout: 10000 });

  // Opening the row is what clears it — not a timeout this test would have to wait out.
  await w.getByTestId("record-open-RQ-0001").click();
  await expect(w.getByTestId("record-changed-RQ-0001")).toHaveCount(0);

  await app.close();
});

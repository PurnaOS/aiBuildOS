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

/**
 * TC-0078. Talking a story into work lands it in review, against the running application and the
 * stub's file-writer mode.
 *
 * Verifies RQ-0027#AC-1 (the rail's "Work on this" walks a ready Story the same way the board's
 * Build does) and the AC-4 half that belongs here rather than in `workon`'s own module test: the
 * Build control a ready card offers is one control, not one per harness.
 *
 * Mirrors `worktree.spec.ts`'s fixture mechanics (seed, index rows, the `{{OWNER}}` loop) — the same
 * shape of story, requirement and test case, worked on from the record rail instead of the board.
 */
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const template = fileURLToPath(new URL("../src/main/okf-template/docs", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

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

A scripted slice: whatever the agent writes to \`notes.md\`.

## Acceptance criteria

- [AC-1] notes.md contains a new line.
`;

function seed(): { config: string; work: string } {
  const config = mkdtempSync(join(tmpdir(), "workon-config-"));
  const work = mkdtempSync(join(tmpdir(), "workon-work-"));
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

  // The template ships every playbook with an unresolved `{{OWNER}}` token (build.spec.ts, worktree.
  // spec.ts hit the same thing) — filled in by hand since this fixture skips `fillProject`.
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"), "utf8");
  }

  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", ["-C", work, "commit", "-m", "seed", "--quiet"]);

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=file-writer"],
      },
    ]),
  );
  writeFileSync(
    join(config, "projects.json"),
    JSON.stringify([{ id: "p1", name: "demo", path: work, lastOpened: null }]),
  );

  return { config, work };
}

async function open(config: string): Promise<{ app: ElectronApplication; w: Page }> {
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

test("talking a ready story into work lands it in review, and the Build control offers harness and here-or-worktree", async () => {
  const { config, work } = seed();
  const { app, w } = await open(config);
  const storyFile = join(work, "docs/user-stories/st-0001.md");

  // AC-4's other half (TC-0044): one Build control per ready card, not one button per harness.
  await w.getByTestId("tab-work").click();
  await expect(w.getByTestId("board-card-build-ST-0001")).toHaveText("Build");
  await w.getByTestId("board-card-build-menu-ST-0001").click();
  await expect(w.getByTestId("board-card-build-worktree-ST-0001-h")).toContainText(
    "In a worktree — Stub",
  );
  // Closed again without pressing either — this is a look at the menu, not a build.
  await w.getByTestId("board-card-build-menu-ST-0001").click();
  await expect(w.getByTestId("board-card-build-worktree-ST-0001-h")).toHaveCount(0);

  // "Work on this", from the record rail rather than the board — pressed before any session
  // exists, exactly as build.spec.ts presses the board's own Build, so the walk's two guarded
  // saves land deterministically rather than racing the stub's turn.
  await w.getByRole("button", { name: "Expand ST-0001" }).click();
  await w.getByTestId("work-on-ST-0001").click();

  await expect.poll(() => readFileSync(storyFile, "utf8")).toContain("state: building");

  // The composed prompt is queued (`setPending`) but not sent until a session exists to receive
  // it — starting one now delivers it, and that is the turn the file-writer stub answers.
  await w.getByTestId("tab-chat").click();
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  // The composed build playbook, sent as the user's own message and visible in the transcript.
  const surface = w.locator(".copilotKitMessages");
  await expect(surface).toContainText("I will name one Story.", { timeout: 20000 });
  await expect(surface).toContainText("ST-0001: Write a note");
  await expect(surface).toContainText("RQ-0001: Notes get written");

  // The turn ending flips the story to review — the same turn-end walk build.spec.ts exercises.
  await expect
    .poll(() => readFileSync(storyFile, "utf8"), { timeout: 20000 })
    .toContain("state: review");

  await app.close();
});

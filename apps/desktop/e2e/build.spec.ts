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
 * TC-0049. A story is built, reviewed beside its criteria, and accepted.
 *
 * Against the stub agent's `--mode=file-writer`, which appends one scripted line to `notes.md` and
 * a diff for it, per turn. Verifies RQ-0015#AC-1 to AC-5 through the running application.
 */
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

async function open(): Promise<{ app: ElectronApplication; w: Page; work: string }> {
  const config = mkdtempSync(join(tmpdir(), "build-config-"));
  const work = mkdtempSync(join(tmpdir(), "build-work-"));
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

  // The template ships every playbook with an unresolved `{{OWNER}}` token — `fillProject` fills it
  // in normally, and this fixture skips that, so it is filled in by hand the same way playbooks.spec
  // does. Left unresolved, `owner: {{OWNER}}` is not valid YAML.
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
  return { app, w, work };
}

test("a story is built, flips to review on turn end, is sent back with a note, and is accepted — with Git left untouched", async () => {
  const { app, w, work } = await open();
  const storyFile = join(work, "docs/user-stories/st-0001.md");
  const notesFile = join(work, "notes.md");
  const seedLog = execFileSync("git", ["-C", work, "log", "--oneline"], {
    encoding: "utf8",
  }).trim();

  // AC-1: Build walks ready → queued → building, on disk and on the board — pressed before a session
  // exists, so the walk's two guarded saves land deterministically, ahead of anything the stub could
  // race them with. RQ-0045#AC-4: the primary press is a worktree build now, so the in-chat build
  // this test exercises presses "In this conversation" behind the caret instead.
  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-build-menu-ST-0001").click();
  await w.getByTestId("board-card-build-chat-ST-0001").click();

  await expect.poll(() => readFileSync(storyFile, "utf8")).toContain("state: building");
  await expect(
    w.getByTestId("board-column-building").getByTestId("board-card-ST-0001"),
  ).toBeVisible();

  // The build prompt is queued (`onPrompt`) but not sent until a session exists to receive it —
  // starting one now delivers it, and that is the turn file-writer answers.
  await w.getByTestId("tab-chat").click();
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  const surface = w.locator(".copilotKitMessages");
  await expect(surface).toContainText("ST-0001", { timeout: 20000 });

  // AC-2/AC-3: the turn ending flips the story to review, and review shows the criteria beside the
  // diff of what the stub actually changed.
  await expect
    .poll(() => readFileSync(storyFile, "utf8"), { timeout: 20000 })
    .toContain("state: review");

  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-review-ST-0001").click();
  await expect(w.getByTestId("review-tab")).toBeVisible();
  await expect(w.getByTestId("review-story")).toContainText("AC-1");
  await expect(w.getByTestId("review-story")).toContainText("notes.md contains a new line");
  await expect(w.getByTestId("review-diffs")).toContainText("notes.md");
  await expect(w.getByTestId("review-diffs")).toContainText("built: turn 1");

  // AC-4: send-back flips to building, the note lands on the story, and the note is on its way to
  // the agent as a new, visible turn.
  await w.getByTestId("review-note").fill("Please also cover the second file.");
  await w.getByTestId("review-send-back").click();

  await expect.poll(() => readFileSync(storyFile, "utf8")).toContain("state: building");
  expect(readFileSync(storyFile, "utf8")).toContain("## Review notes");
  expect(readFileSync(storyFile, "utf8")).toContain("Please also cover the second file.");
  await expect(surface).toContainText("Please also cover the second file.", { timeout: 20000 });

  // Let the second turn end — building → review again.
  await expect
    .poll(() => readFileSync(storyFile, "utf8"), { timeout: 20000 })
    .toContain("state: review");

  // AC-4: Accept is the one flip, review → accepted.
  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-review-ST-0001").click();
  await expect(w.getByTestId("review-tab")).toBeVisible();
  await w.getByTestId("review-accept").click();

  await expect.poll(() => readFileSync(storyFile, "utf8")).toContain("state: accepted");

  // AC-5: nothing here ever touched Git. The seed commit is still the only one, and the stub's
  // change to notes.md is still sitting uncommitted in the working tree.
  const finalLog = execFileSync("git", ["-C", work, "log", "--oneline"], {
    encoding: "utf8",
  }).trim();
  expect(finalLog).toBe(seedLog);
  const status = execFileSync("git", ["-C", work, "status", "--porcelain"], { encoding: "utf8" });
  expect(status).toContain("notes.md");
  expect(readFileSync(notesFile, "utf8")).toContain("built: turn");

  await app.close();
});

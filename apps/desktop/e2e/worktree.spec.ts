import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
 * TC-0067. A worktree build leaves the workspace free, and lands on accept — against the running
 * application, the stub agent spawned with a worktree `cwd` exactly the way a real one would be.
 *
 * Mirrors `build.spec.ts`'s fixture mechanics (seed, index rows, the `{{OWNER}}` loop, config
 * overrides) — the same story, requirement and test case, built in a worktree instead of the main
 * tree. `AIBUILDOS_WORKTREES_ROOT` is set so worktrees land in a temp directory this spec can
 * inspect, rather than a real Electron `userData` this machine happens to have.
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

function seed(mode: string): { config: string; work: string; worktrees: string } {
  const config = mkdtempSync(join(tmpdir(), "worktree-config-"));
  const work = mkdtempSync(join(tmpdir(), "worktree-work-"));
  const worktrees = mkdtempSync(join(tmpdir(), "worktree-root-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);

  cpSync(template, join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ);
  writeFileSync(join(work, "docs/testing/tc-0001.md"), TC);
  writeFileSync(join(work, "docs/user-stories/st-0001.md"), ST);
  // A file already on main, ahead of any build — proves both that the workspace stays usable
  // mid-build (it is opened from here) and that the build never touches main's own copy.
  writeFileSync(join(work, "notes.md"), "existing\n");

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

  // The template ships every playbook with an unresolved `{{OWNER}}` token (build.spec.ts hits the
  // same thing) — filled in by hand since this fixture skips `fillProject`.
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
        args: ["--experimental-strip-types", stub, `--mode=${mode}`],
      },
    ]),
  );
  writeFileSync(
    join(config, "projects.json"),
    JSON.stringify([{ id: "p1", name: "demo", path: work, lastOpened: null }]),
  );

  return { config, work, worktrees };
}

async function open(
  config: string,
  worktrees: string,
): Promise<{ app: ElectronApplication; w: Page }> {
  const app = await electron.launch({
    args: ["."],
    cwd: appRoot,
    env: {
      ...process.env,
      AIBUILDOS_PROJECTS_FILE: join(config, "projects.json"),
      AIBUILDOS_HARNESSES_FILE: join(config, "harnesses.json"),
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
      AIBUILDOS_WORKTREES_ROOT: worktrees,
    },
  });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  return { app, w };
}

test("a worktree build leaves the workspace free, and lands on accept", async () => {
  const { config, work, worktrees } = seed("file-writer");
  const { app, w } = await open(config, worktrees);
  const storyFile = join(work, "docs/user-stories/st-0001.md");
  const wtPath = join(worktrees, "p1", "ST-0001");

  // AC-1: Build-in-a-worktree walks ready → queued → building in main, and creates the worktree —
  // pressed before any turn ran, so the flips land deterministically. RQ-0045#AC-4: the primary
  // press is a worktree build now — with one harness configured, that press alone is the whole
  // story, no caret needed.
  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-build-ST-0001").click();

  // "building" is transient: a fast stub can complete its whole turn between two polls, landing
  // the turn-end flip at review before this reads the file. The guarded save only admits declared
  // transitions, so review is itself proof the walk went ready → queued → building first.
  await expect
    .poll(() => readFileSync(storyFile, "utf8"), { timeout: 20000 })
    .toMatch(/state: (building|review)/);
  await expect.poll(() => existsSync(wtPath)).toBe(true);
  expect(
    execFileSync("git", ["-C", work, "branch", "--list", "aibuildos/st-0001"], {
      encoding: "utf8",
    }).trim(),
  ).toContain("aibuildos/st-0001");

  // Main stays usable while the build runs: notes.md opens as an ordinary file tab, right beside a
  // build that is, at this moment, writing to a file of the same name in its own worktree. The files
  // rail is always visible in its own panel — nothing to switch to first.
  await w.getByTestId("file-row").filter({ hasText: "notes.md" }).click();
  await expect(w.getByTestId("file-tab")).toBeVisible();

  // AC-1/AC-2: the file lands in the worktree, not main — main's own copy is untouched mid-build.
  await expect
    .poll(() => readFileSync(join(wtPath, "notes.md"), "utf8"), { timeout: 20000 })
    .toContain("built: turn 1");
  expect(readFileSync(join(work, "notes.md"), "utf8")).toBe("existing\n");

  // The turn ending flips the story to review — `builds.ts`'s own turn-end hook, in main, against
  // this build's own project (ST-0041), not the main-session `useTurnEnd`.
  await expect
    .poll(() => readFileSync(storyFile, "utf8"), { timeout: 20000 })
    .toContain("state: review");

  // AC-4: review reads the branch's changes, and accept merges --no-ff into main.
  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-review-ST-0001").click();
  await expect(w.getByTestId("review-tab")).toBeVisible();
  await expect(w.getByTestId("review-diffs")).toContainText("notes.md");
  await w.getByTestId("review-accept").click();

  await expect.poll(() => readFileSync(storyFile, "utf8")).toContain("state: accepted");
  expect(readFileSync(join(work, "notes.md"), "utf8")).toContain("built: turn 1");
  expect(existsSync(wtPath)).toBe(false);
  expect(
    execFileSync("git", ["-C", work, "branch", "--list", "aibuildos/st-0001"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("");
  expect(
    execFileSync("git", ["-C", work, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim(),
  ).toBe("ST-0001: accept the build");

  await app.close();
});

test("restart lists a survivor without picking it up on its own", async () => {
  const { config, work, worktrees } = seed("slow");
  const wtPath = join(worktrees, "p1", "ST-0001");
  const storyFile = join(work, "docs/user-stories/st-0001.md");

  const first = await open(config, worktrees);
  // RQ-0045#AC-4: the primary press starts a worktree build now.
  await first.w.getByTestId("tab-work").click();
  await first.w.getByTestId("board-card-build-ST-0001").click();

  // `build:start` creates the worktree before the renderer ever writes `state: building` — seeing
  // the state on disk is already proof the worktree exists, and skipping a second poll for it here
  // widens the margin before `--mode=slow`'s ~500ms turn ends on its own.
  // "building" is transient: a fast stub can complete its whole turn between two polls, landing
  // the turn-end flip at review before this reads the file. The guarded save only admits declared
  // transitions, so review is itself proof the walk went ready → queued → building first.
  await expect
    .poll(() => readFileSync(storyFile, "utf8"), { timeout: 20000 })
    .toMatch(/state: (building|review)/);

  // Closed mid-build, well ahead of that turn ending: `before-quit` closes every session
  // (DC-0021), but the worktree, its branch and the record survive on disk.
  await first.app.close();

  const second = await open(config, worktrees);
  expect(readFileSync(storyFile, "utf8")).toContain("state: building");
  expect(existsSync(wtPath)).toBe(true);
  expect(
    execFileSync("git", ["-C", work, "branch", "--list", "aibuildos/st-0001"], {
      encoding: "utf8",
    }).trim(),
  ).toContain("aibuildos/st-0001");

  // v1: reopening only enumerates the survivor — no session is picked up on its own.
  await second.w.getByTestId("dock-toggle").click();
  await expect(second.w.getByTestId("now-row-ST-0001")).toBeVisible();
  await expect(second.w.getByTestId("now-row-state-ST-0001")).toHaveText("no session yet");

  await second.app.close();
});

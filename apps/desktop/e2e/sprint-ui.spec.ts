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
 * TC-0092, TC-0102 — the Work header's sprint controls and the composer's background playbook
 * variant, against the running application. Mirrors `worktree.spec.ts`'s isolation idiom (a
 * throwaway config dir, work tree and worktrees root per test) and `playbooks.spec.ts`'s composer
 * fixture for the background half.
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

function story(id: string, title: string): string {
  return `---
type: Story
id: ${id}
title: "${title}"
state: ready
owner: srini
provenance: human
created: 2026-08-19
links:
  implements: [RQ-0001]
  verified_by: [TC-0001]
---

# ${id} — ${title}

A scripted slice: whatever the agent writes to \`notes.md\`.

## Acceptance criteria

- [AC-1] notes.md contains a new line.
`;
}

/** Two ready stories, a requirement and a test case — the picked-into-a-sprint fixture. */
function seedSprint(mode: string): { config: string; work: string; worktrees: string } {
  const config = mkdtempSync(join(tmpdir(), "sprint-ui-config-"));
  const work = mkdtempSync(join(tmpdir(), "sprint-ui-work-"));
  const worktrees = mkdtempSync(join(tmpdir(), "sprint-ui-root-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);

  cpSync(template, join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ);
  writeFileSync(join(work, "docs/testing/tc-0001.md"), TC);
  writeFileSync(join(work, "docs/user-stories/st-0001.md"), story("ST-0001", "Write note A"));
  writeFileSync(join(work, "docs/user-stories/st-0002.md"), story("ST-0002", "Write note B"));

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
    `${readFileSync(stIndex, "utf8")}` +
      `| [ST-0001](st-0001.md) | Write note A | ready | [RQ-0001](../requirements/rq-0001.md) |\n` +
      `| [ST-0002](st-0002.md) | Write note B | ready | [RQ-0001](../requirements/rq-0001.md) |\n`,
  );

  // The template ships every playbook with an unresolved `{{OWNER}}` token.
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

/** Build one story inside the currently selected sprint, wait for its turn-end flip to review, on
 * disk (the same poll `worktree.spec.ts` and `build.spec.ts` use), then accept it. */
async function buildAndAccept(w: Page, storyFile: string, storyId: string): Promise<void> {
  await w.getByTestId(`board-card-build-${storyId}`).click();
  await expect
    .poll(() => readFileSync(storyFile, "utf8"), { timeout: 20000 })
    .toMatch(/state: (building|review)/);
  await expect
    .poll(() => readFileSync(storyFile, "utf8"), { timeout: 20000 })
    .toContain("state: review");

  await w.getByTestId("tab-work").click();
  await w.getByTestId(`board-card-review-${storyId}`).click();
  await expect(w.getByTestId("review-tab")).toBeVisible();
  // `ReviewTab`'s own `load()` settles which kind of accept this is (worktree merge vs a plain
  // flip) asynchronously — waiting for the diff to actually show is what `worktree.spec.ts` does
  // before ever pressing accept, and skipping it races the two.
  await expect(w.getByTestId("review-diffs")).toContainText("notes.md");
  await w.getByTestId("review-accept").click();
  await expect.poll(() => readFileSync(storyFile, "utf8")).toContain("state: accepted");
  await w.getByTestId("tab-work").click();
}

test("a sprint starts from picked stories, builds branch off it, and finishing merges main", async () => {
  const { config, work, worktrees } = seedSprint("file-writer");
  const { app, w } = await open(config, worktrees);

  await w.getByTestId("tab-work").click();

  // RQ-0035#AC-1: pick two ready stories, start a sprint.
  await w.getByTestId("sprint-pick-ST-0001").click();
  await w.getByTestId("sprint-pick-ST-0002").click();
  await expect(w.getByTestId("sprint-start")).toHaveText("Start a sprint with 2 stories");
  await w.getByTestId("sprint-start").click();

  // The mint (record, `links.contains`) and the git side (branch + worktree) both land, and the
  // header settles on the new sprint.
  await expect(w.getByTestId("sprint-select")).toHaveValue("SP-0001", { timeout: 20000 });
  expect(existsSync(join(work, "docs/sprints/sp-0001.md"))).toBe(true);
  expect(
    execFileSync("git", ["-C", work, "branch", "--list", "aibuildos/sp-0001"], {
      encoding: "utf8",
    }).trim(),
  ).toContain("aibuildos/sp-0001");
  expect(existsSync(join(worktrees, "p1", "SP-0001"))).toBe(true);

  // RQ-0035#AC-2, DC-0025: a story built while the header is filtered to the sprint branches from
  // it, not from `HEAD` — the `--` binding is right there in the branch name, checked mid-build
  // before accept deletes it.
  const st1File = join(work, "docs/user-stories/st-0001.md");
  await w.getByTestId(`board-card-build-ST-0001`).click();
  await expect
    .poll(() => existsSync(join(worktrees, "p1", "ST-0001")), { timeout: 20000 })
    .toBe(true);
  expect(
    execFileSync("git", ["-C", work, "branch", "--list", "aibuildos/sp-0001--st-0001"], {
      encoding: "utf8",
    }).trim(),
  ).toContain("aibuildos/sp-0001--st-0001");
  await expect
    .poll(() => readFileSync(st1File, "utf8"), { timeout: 20000 })
    .toContain("state: review");
  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-review-ST-0001").click();
  await expect(w.getByTestId("review-tab")).toBeVisible();
  // See `buildAndAccept`'s own comment: wait for the diff before pressing accept, or the tab's
  // async `load()` may not have settled `worktree` yet.
  await expect(w.getByTestId("review-diffs")).toContainText("notes.md");
  await w.getByTestId("review-accept").click();
  await expect.poll(() => readFileSync(st1File, "utf8")).toContain("state: accepted");
  await w.getByTestId("tab-work").click();

  // The merge landed on the sprint's own worktree, never on main (DC-0025).
  expect(readFileSync(join(worktrees, "p1", "SP-0001", "notes.md"), "utf8")).toContain(
    "built: turn 1",
  );
  expect(existsSync(join(work, "notes.md"))).toBe(false);

  await buildAndAccept(w, join(work, "docs/user-stories/st-0002.md"), "ST-0002");

  // RQ-0035#AC-5: the header's progress count, and Finish enabled only once every member is
  // accepted.
  await expect(w.getByTestId("sprint-progress")).toHaveText("2/2 accepted");
  await expect(w.getByTestId("sprint-finish")).toBeEnabled();

  // RQ-0035#AC-3: Finish confirms through the application's own dialog, never `window.confirm`.
  await w.getByTestId("sprint-finish").click();
  await expect(w.getByTestId("sprint-finish-dialog")).toBeVisible();
  await w.getByTestId("sprint-finish-confirm").click();

  await expect.poll(() => existsSync(join(work, "notes.md")), { timeout: 20000 }).toBe(true);
  expect(readFileSync(join(work, "notes.md"), "utf8")).toContain("built: turn 1");
  expect(
    execFileSync("git", ["-C", work, "log", "-1", "--format=%s"], { encoding: "utf8" }).trim(),
  ).toBe("SP-0001: finish the sprint");
  expect(
    execFileSync("git", ["-C", work, "branch", "--list", "aibuildos/sp-0001"], {
      encoding: "utf8",
    }).trim(),
  ).toBe("");
  expect(existsSync(join(worktrees, "p1", "SP-0001"))).toBe(false);

  await app.close();
});

/**
 * TC-0102 — a background playbook run beside the chat (RQ-0039). Two harnesses: the main chat
 * attaches with the fast one, PB-0003 is given a `harness` preference naming the slow one, so the
 * background run is provably still going while the main chat answers.
 */
function seedBackground(): { config: string } {
  const config = mkdtempSync(join(tmpdir(), "sprint-ui-bg-config-"));
  const work = mkdtempSync(join(tmpdir(), "sprint-ui-bg-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);
  cpSync(template, join(work, "docs"), { recursive: true });

  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"), "utf8");
  }
  // PB-0003 prefers the slow harness (RQ-0013#AC-6's own field) — its normal press still runs with
  // whatever the main chat attached, `resolveHarness`'s fallback; only the background variant, which
  // has no attached chat to fall back to, actually spawns with it.
  const pb3 = join(work, "docs", "playbooks", "pb-0003.md");
  writeFileSync(
    pb3,
    readFileSync(pb3, "utf8").replace(
      "created: 2026-08-20\n",
      'created: 2026-08-20\nharness: "Slower"\n',
    ),
  );

  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", ["-C", work, "commit", "-m", "seed", "--quiet"]);

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=echo"],
      },
      {
        id: "h2",
        displayName: "Slower",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=slower"],
      },
    ]),
  );
  writeFileSync(
    join(config, "projects.json"),
    JSON.stringify([{ id: "p1", name: "demo", path: work, lastOpened: null }]),
  );

  return { config };
}

test("a playbook runs in the background while the chat keeps talking, and its tab opens", async () => {
  const { config } = seedBackground();
  const { app, w } = await open(config, mkdtempSync(join(tmpdir(), "sprint-ui-bg-root-")));

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  await w.getByTestId("composer-menu-trigger").click();
  const menu = w.getByTestId("composer-menu");
  await menu.getByTestId("playbook-background-PB-0003").click();

  // RQ-0039#AC-3: the session tab opens as the background run starts — no dock click needed.
  await expect(w.locator('[data-testid^="tab-session:"]')).toBeVisible({ timeout: 20000 });
  await expect(w.getByTestId("session-tab")).toBeVisible();
  // A success closes the popover behind it — only a refusal is meant to hold it open.
  await expect(w.getByTestId("composer-menu")).not.toBeVisible();

  // RQ-0039#AC-1, AC-5: back on the main chat, the composer still accepts input and sends while
  // the background run (on the slow harness) is still streaming.
  await w.getByTestId("tab-chat").click();
  await expect(w.getByTestId("composer-textarea")).toBeEnabled();
  await w.getByTestId("composer-textarea").fill("still here?");
  await w.getByTestId("copilot-send-button").click();
  await expect(w.locator(".copilotKitMessages")).toContainText("still here?");

  await app.close();
});

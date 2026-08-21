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
 * TC-0056. The Git tab commits, and accepting a story offers to.
 *
 * Verifies RQ-0018#AC-1, AC-2, AC-4 and AC-5 through the running application: the tab's own
 * stage/commit controls against a plain edit, then the offer a story's acceptance makes — declined
 * once, with nothing landing in the log, then made for real from the Git tab.
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

const README_SEEDED = "# demo\n";
const README_EDITED = "# demo\n\nEdited by hand.\n";

function log(work: string): string[] {
  return execFileSync("git", ["-C", work, "log", "--oneline"], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((line) => line !== "");
}

async function open(): Promise<{ app: ElectronApplication; w: Page; work: string }> {
  const config = mkdtempSync(join(tmpdir(), "commit-config-"));
  const work = mkdtempSync(join(tmpdir(), "commit-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);
  // Unlike build.spec.ts, this suite commits *through the running app* — a repo-local identity is
  // not enough if signing is on globally and no agent is present to satisfy it (git.test.ts's own
  // fixtures set this for the same reason).
  execFileSync("git", ["-C", work, "config", "commit.gpgsign", "false"]);

  cpSync(template, join(work, "docs"), { recursive: true });
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ);
  writeFileSync(join(work, "docs/testing/tc-0001.md"), TC);
  writeFileSync(join(work, "docs/user-stories/st-0001.md"), ST);
  writeFileSync(join(work, "README.md"), README_SEEDED);

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

  // Every playbook ships with an unresolved `{{OWNER}}` token — filled by hand, the way
  // build.spec / playbooks.spec do for a fixture that skips `fillProject`.
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"), "utf8");
  }

  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", ["-C", work, "commit", "-m", "seed", "--quiet"]);

  // The "edit" TC-0056's first step commits: made before launch, exactly as if it happened in any
  // editor — Git does not know or care who wrote it.
  writeFileSync(join(work, "README.md"), README_EDITED);

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

test("the Git tab stages and commits an edit, and accepting a story offers a commit that only a press performs", async () => {
  const { app, w, work } = await open();
  const seedLog = log(work);
  expect(seedLog).toHaveLength(1);

  // AC-1/AC-2: a plain edit, staged one path at a time from the tab, commits with the typed
  // message — the counts follow every step, and the tab lands on "Working tree clean."
  await w.getByTestId("rail-tab-git").click();
  await expect(w.getByTestId("stage-row")).toHaveCount(1);
  // Nothing staged and no message yet: the button refuses rather than being clickable at all.
  await expect(w.getByTestId("commit-button")).toBeDisabled();
  expect(log(work)).toEqual(seedLog);

  await w.getByTestId("stage-row").click();
  await expect(w.getByTestId("stage-row")).toHaveCount(0);
  await expect(w.getByTestId("unstage-row")).toHaveCount(1);

  await w.getByTestId("commit-message").fill("Edit the readme by hand");
  await w.getByTestId("commit-button").click();

  await expect(w.getByTestId("changes-clean")).toBeVisible();
  await expect(w.getByTestId("commit-message")).toHaveValue("");
  // AC-2: "appears in the history the tab already shows" — the rendered list, not only the repo.
  await expect(w.getByTestId("files-rail")).toContainText("Edit the readme by hand");
  const afterReadme = log(work);
  expect(afterReadme).toHaveLength(2);
  expect(readFileSync(join(work, "README.md"), "utf8")).toBe(README_EDITED);

  // AC-4/AC-5: build and accept a story through the stub's file-writer, the same walk build.spec
  // exercises — the point here is what happens *after* Accept, not the walk itself. RQ-0045#AC-4:
  // the primary press is a worktree build now, so this in-chat build reaches "In this
  // conversation" behind the caret instead.
  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-build-menu-ST-0001").click();
  await w.getByTestId("board-card-build-chat-ST-0001").click();
  await expect
    .poll(() => readFileSync(join(work, "docs/user-stories/st-0001.md"), "utf8"))
    .toContain("state: building");

  await w.getByTestId("tab-chat").click();
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });
  await expect(w.locator(".copilotKitMessages")).toContainText("ST-0001", { timeout: 20000 });

  await expect
    .poll(() => readFileSync(join(work, "docs/user-stories/st-0001.md"), "utf8"), {
      timeout: 20000,
    })
    .toContain("state: review");

  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-review-ST-0001").click();
  await expect(w.getByTestId("review-tab")).toBeVisible();
  await w.getByTestId("review-accept").click();

  // The offer names the story — its ID and its title — and nothing has committed for it yet.
  const offer = w.getByTestId("review-commit-offer");
  await expect(offer).toBeVisible();
  await expect(offer).toContainText("ST-0001");
  await expect(offer).toContainText("Write a note");
  expect(log(work)).toEqual(afterReadme);

  // Declining performs nothing at all — the log is exactly what it was.
  await w.getByTestId("review-commit-decline").click();
  await expect(offer).toBeHidden();
  expect(log(work)).toEqual(afterReadme);

  // The offer is gone from this tab (declining dismissed it); the same commit is still reachable
  // from the Git tab, one path at a time, the way any other commit in this application is made.
  // The story's own file, its index row and the new `notes.md` all changed — not asserting a
  // fixed count, since which files an accepted flip touches is the index's business, not this
  // test's.
  await w.getByTestId("rail-tab-git").click();
  await expect(w.getByTestId("stage-row").first()).toBeVisible();
  let remaining = await w.getByTestId("stage-row").count();
  while (remaining > 0) {
    await w.getByTestId("stage-row").first().click();
    const before = remaining;
    await expect.poll(() => w.getByTestId("stage-row").count()).toBeLessThan(before);
    remaining = await w.getByTestId("stage-row").count();
  }
  await expect(w.getByTestId("unstage-row").first()).toBeVisible();

  await w.getByTestId("commit-message").fill("ST-0001: Write a note");
  await w.getByTestId("commit-button").click();
  await expect(w.getByTestId("changes-clean")).toBeVisible();

  // Exactly one commit landed for the whole build/accept episode — not zero, not more than one.
  const finalLog = log(work);
  expect(finalLog).toHaveLength(afterReadme.length + 1);
  expect(readFileSync(join(work, "notes.md"), "utf8")).toContain("built: turn");

  await app.close();
});

test("the review tab's offer, pressed, stages every changed path itself and commits with the story's own message", async () => {
  const { app, w, work } = await open();
  const seedLog = log(work);

  // RQ-0045#AC-4: the primary press is a worktree build now — this in-chat build reaches "In this
  // conversation" behind the caret instead.
  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-build-menu-ST-0001").click();
  await w.getByTestId("board-card-build-chat-ST-0001").click();
  await expect
    .poll(() => readFileSync(join(work, "docs/user-stories/st-0001.md"), "utf8"))
    .toContain("state: building");

  await w.getByTestId("tab-chat").click();
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });
  await expect(w.locator(".copilotKitMessages")).toContainText("ST-0001", { timeout: 20000 });

  await expect
    .poll(() => readFileSync(join(work, "docs/user-stories/st-0001.md"), "utf8"), {
      timeout: 20000,
    })
    .toContain("state: review");

  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-review-ST-0001").click();
  await expect(w.getByTestId("review-tab")).toBeVisible();
  await w.getByTestId("review-accept").click();

  const offer = w.getByTestId("review-commit-offer");
  await expect(offer).toContainText("ST-0001: Write a note");
  // The offer only offers: nothing has landed until the press below.
  expect(log(work)).toEqual(seedLog);

  await w.getByTestId("review-commit-accept").click();
  await expect(offer).toBeHidden();

  // One commit, named after the story, and — because staging reached every changed path, the
  // by-hand README edit from before this walk began included — nothing left uncommitted.
  const finalLog = log(work);
  expect(finalLog).toHaveLength(seedLog.length + 1);
  const subject = execFileSync("git", ["-C", work, "log", "-1", "--format=%s"], {
    encoding: "utf8",
  }).trim();
  expect(subject).toBe("ST-0001: Write a note");
  expect(
    execFileSync("git", ["-C", work, "status", "--porcelain"], { encoding: "utf8" }).trim(),
  ).toBe("");

  await app.close();
});

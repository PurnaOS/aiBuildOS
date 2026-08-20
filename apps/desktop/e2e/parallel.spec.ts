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
 * TC-0069. Two builds at once, each in its own worktree — one stub `--mode=slow`, the other
 * `--mode=file-writer`, two harnesses in the one fixture so each story can be built with a specific
 * one. Cancelling the slow one must leave the other running and finishing on its own.
 */
const appRoot = fileURLToPath(new URL("..", import.meta.url));
const template = fileURLToPath(new URL("../src/main/okf-template/docs", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

function requirement(id: string, title: string): string {
  return `---
type: Requirement
id: ${id}
title: "${title}"
state: ready
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# ${id} — ${title}

## Acceptance criteria

- [AC-1] It does the thing.
`;
}

function testCase(id: string, requirementId: string): string {
  return `---
type: TestCase
id: ${id}
title: "${requirementId} behaves as asked"
state: draft
owner: srini
provenance: human
created: 2026-08-19
kind: manual
links:
  verifies: [${requirementId}]
---

# ${id} — ${requirementId} behaves as asked

## Steps

1. Exercise ${requirementId} and expect what it promises.
`;
}

function story(id: string, requirementId: string, testCaseId: string): string {
  return `---
type: Story
id: ${id}
title: "Deliver ${requirementId}"
state: ready
owner: srini
provenance: human
created: 2026-08-19
links:
  implements: [${requirementId}]
  verified_by: [${testCaseId}]
---

# ${id} — Deliver ${requirementId}

A scripted slice for ${requirementId}.

## Acceptance criteria

- [AC-1] The behaviour ${requirementId} asks for is observable.
`;
}

async function open(): Promise<{
  app: ElectronApplication;
  w: Page;
  work: string;
  worktrees: string;
}> {
  const config = mkdtempSync(join(tmpdir(), "parallel-config-"));
  const work = mkdtempSync(join(tmpdir(), "parallel-work-"));
  const worktrees = mkdtempSync(join(tmpdir(), "parallel-root-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);

  cpSync(template, join(work, "docs"), { recursive: true });

  const pairs = [
    { rq: "RQ-0001", tc: "TC-0001", st: "ST-0001" },
    { rq: "RQ-0002", tc: "TC-0002", st: "ST-0002" },
  ];
  for (const { rq, tc, st } of pairs) {
    writeFileSync(join(work, `docs/requirements/${rq.toLowerCase()}.md`), requirement(rq, rq));
    writeFileSync(join(work, `docs/testing/${tc.toLowerCase()}.md`), testCase(tc, rq));
    writeFileSync(join(work, `docs/user-stories/${st.toLowerCase()}.md`), story(st, rq, tc));

    const rqIndex = join(work, "docs/requirements/README.md");
    writeFileSync(
      rqIndex,
      `${readFileSync(rqIndex, "utf8")}| [${rq}](${rq.toLowerCase()}.md) | ${rq} | ready | — |\n`,
    );
    const tcIndex = join(work, "docs/testing/README.md");
    writeFileSync(
      tcIndex,
      `${readFileSync(tcIndex, "utf8")}| [${tc}](${tc.toLowerCase()}.md) | ${rq} behaves as asked | draft | [${rq}](../requirements/${rq.toLowerCase()}.md) |\n`,
    );
    const stIndex = join(work, "docs/user-stories/README.md");
    writeFileSync(
      stIndex,
      `${readFileSync(stIndex, "utf8")}| [${st}](${st.toLowerCase()}.md) | Deliver ${rq} | ready | [${rq}](../requirements/${rq.toLowerCase()}.md) |\n`,
    );
  }

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
        id: "slow",
        displayName: "Slow",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=slow"],
      },
      {
        id: "writer",
        displayName: "Writer",
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
      AIBUILDOS_WORKTREES_ROOT: worktrees,
    },
  });
  const w = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  return { app, w, work, worktrees };
}

test("two builds run side by side, and cancelling one leaves the other running", async () => {
  const { app, w, work, worktrees } = await open();
  const story1File = join(work, "docs/user-stories/st-0001.md");
  const story2File = join(work, "docs/user-stories/st-0002.md");
  const wt1 = join(worktrees, "p1", "ST-0001");
  const wt2 = join(worktrees, "p1", "ST-0002");

  await w.getByTestId("tab-board").click();
  await w.getByTestId("board-view-work").click();

  // AC-1: two stories build at once, each its own worktree, no shared working directory.
  await w.getByTestId("board-card-build-worktree-ST-0001-slow").click();
  await w.getByTestId("board-card-build-worktree-ST-0002-writer").click();

  // TC-0074 (BG-0008): open the writer's session tab right away. Its single file-writer turn has no
  // artificial delay, so subscribing any later risks its tool call's event having already come and
  // gone with nobody listening — `session:event` is live, never replayed for a late subscriber.
  await w.getByTestId("tab-now").click();
  await w.getByTestId("now-row-open-ST-0002").click();
  await expect(w.getByTestId("session-transcript")).toContainText("Ran: Edit notes.md", {
    timeout: 20000,
  });

  // The slow build holds `building` long enough to observe; the writer's turn ends so fast that
  // its `building` is a blink `builds.ts`'s own turn-end flip (ST-0041) correctly lands before any
  // poll can see it — its parallelism is proven by the simultaneous worktrees and live Now rows
  // below, and its terminal truth (`review`) is asserted at the end.
  await expect.poll(() => readFileSync(story1File, "utf8")).toContain("state: building");
  await expect.poll(() => existsSync(wt1)).toBe(true);
  await expect.poll(() => existsSync(wt2)).toBe(true);
  expect(wt1).not.toBe(wt2);

  // AC-2: both on Now, live.
  await w.getByTestId("tab-now").click();
  await expect(w.getByTestId("now-row-ST-0001")).toBeVisible();
  await expect(w.getByTestId("now-row-ST-0002")).toBeVisible();

  // AC-4: cancel the slow one; its row says so, the other keeps going.
  await w.getByTestId("now-row-cancel-ST-0001").click();
  await expect(w.getByTestId("now-row-state-ST-0001")).toHaveText("cancelled");

  await expect
    .poll(() => readFileSync(story2File, "utf8"), { timeout: 20000 })
    .toContain("state: review");

  // The boards told the truth throughout: the finished build is where review says it is, cancelling
  // it did not touch the other story at all.
  await w.getByTestId("tab-board").click();
  await expect(
    w.getByTestId("board-column-review").getByTestId("board-card-ST-0002"),
  ).toBeVisible();

  await app.close();
});

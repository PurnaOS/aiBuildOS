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
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));
const template = fileURLToPath(new URL("../src/main/okf-template/docs", import.meta.url));
const okfCli = fileURLToPath(new URL("../../../tools/okf/cli.ts", import.meta.url));

/**
 * TC-0059. The whole loop, one session: pick → plan → approve → build → review → accept.
 *
 * plan.spec and build.spec each prove half against their own fixtures; this is the seam between
 * them — the story the agent itself drafted (owner `stub`, no parent epic) carried through
 * approval and a build without a hand-written artifact anywhere. The stub's `journey` mode plans
 * on its first prompt and builds on the rest.
 */
const RQ = `---
type: Requirement
id: RQ-0001
title: "The first thing"
state: ready
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0001 — The first thing

## Acceptance criteria

- [AC-1] It does the thing.
`;

test("an idea picked on the board is planned, approved, built and accepted", async () => {
  const config = mkdtempSync(join(tmpdir(), "journey-config-"));
  const work = mkdtempSync(join(tmpdir(), "journey-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  cpSync(template, join(work, "docs"), { recursive: true });
  // A raw template copy leaves `owner: {{OWNER}}` in the seed playbooks — resolved here the way
  // findings.spec.ts does, or the final docs:check assertion fails on every playbook.
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, `docs/playbooks/${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "srini"));
  }
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ);
  const index = join(work, "docs/requirements/README.md");
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | The first thing | ready | — |\n`,
  );
  execFileSync("git", ["-C", work, "add", "-A"]);
  execFileSync("git", [
    "-C",
    work,
    "-c",
    "user.email=t@e.com",
    "-c",
    "user.name=T",
    "commit",
    "-q",
    "-m",
    "seed",
  ]);

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=journey"],
      },
    ]),
  );
  writeFileSync(
    join(config, "projects.json"),
    JSON.stringify([{ id: "p1", name: "demo", path: work, lastOpened: null }]),
  );

  const app: ElectronApplication = await electron.launch({
    args: ["."],
    cwd: appRoot,
    env: {
      ...process.env,
      AIBUILDOS_PROJECTS_FILE: join(config, "projects.json"),
      AIBUILDOS_HARNESSES_FILE: join(config, "harnesses.json"),
      AIBUILDOS_SETTINGS_FILE: join(config, "settings.json"),
    },
  });
  const w: Page = await app.firstWindow();
  await w.setViewportSize({ width: 1440, height: 900 });
  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  // Pick, and ask for the plan. The backlog lives on the Plan surface now (RQ-0045#AC-1).
  await w.getByTestId("tab-plan").click();
  await w.getByTestId("plan-pick-RQ-0001").check();
  await w.getByTestId("plan-start").click();
  await w.getByTestId("tab-chat").click();
  await expect(w.locator(".copilotKitMessages")).toContainText("Proposed 1 draft stories.", {
    timeout: 20000,
  });

  // Review what the agent drafted, and approve it. No banner, no second door: the drafts are on
  // the surface they belong to, reachable by browsing (RQ-0045#AC-2).
  await w.getByTestId("tab-plan").click();
  await expect(w.getByTestId("plan-story-ST-0001")).toBeVisible();
  await w.getByTestId("plan-approve").click();
  await expect(w.getByTestId("plan-empty")).toBeVisible({ timeout: 15000 });
  expect(readFileSync(join(work, "docs/user-stories/st-0001.md"), "utf8")).toContain(
    "state: ready",
  );

  // Build it, and let the turn end move it to review. This journey is the in-conversation build,
  // which now lives behind the Build control's caret — the primary press starts a worktree build
  // (RQ-0045#AC-4), and that path has worktree.spec and parallel.spec to itself.
  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-build-menu-ST-0001").click();
  await w.getByTestId("board-card-build-chat-ST-0001").click();
  await expect(w.getByTestId("board-column-review").getByTestId("board-card-ST-0001")).toBeVisible({
    timeout: 30000,
  });

  // The dock said so before the board did: work in motion is visible from wherever you stand, and
  // its next-action line names the one thing left to do (RQ-0044#AC-3).
  await expect(w.getByTestId("dock-next-action-text")).toContainText("ST-0001", {
    timeout: 30000,
  });

  // Accept what came back, beside what was asked for — the checks section stands beside the
  // criteria (RQ-0019#AC-4; the template's placeholder playbook is enough for it to exist).
  await w.getByTestId("board-card-review-ST-0001").click();
  await expect(w.getByTestId("review-tab")).toBeVisible();
  await expect(w.getByTestId("checks")).toBeVisible();
  await expect(w.getByTestId("review-diffs")).toContainText("notes.md");
  await w.getByTestId("review-accept").click();
  await expect
    .poll(() => readFileSync(join(work, "docs/user-stories/st-0001.md"), "utf8"))
    .toContain("state: accepted");

  // Accept offers a commit and declining it commits nothing (RQ-0018#AC-4, AC-5).
  await expect(w.getByTestId("review-commit-offer")).toBeVisible();
  await w.getByTestId("review-commit-decline").click();
  await expect(w.getByTestId("review-commit-offer")).toHaveCount(0);

  // The record the loop leaves behind is one docs:check accepts, and Git holds only the seed.
  expect(() => execFileSync("bun", [okfCli, "docs"], { cwd: work })).not.toThrow();
  const log = execFileSync("git", ["-C", work, "log", "--oneline"], { encoding: "utf8" });
  expect(log.trim().split("\n")).toHaveLength(1);

  await app.close();
});

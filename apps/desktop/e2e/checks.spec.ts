import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * TC-0058. The checks run beside a story's review, and a failure goes to the agent.
 *
 * Against the stub agent's `--mode=echo`, the same proof `playbooks.spec.ts` uses: the transcript
 * shows exactly what was sent, which is how "one visible prompt carrying the failing command and its
 * output" (RQ-0019#AC-4) is verified without inventing a second way to inspect what crossed IPC.
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

/** Seeded straight at `review` — TC-0058 is about the review surface, not the build walk ST-0028
 * already covers in `build.spec.ts`. */
const ST = `---
type: Story
id: ST-0001
title: "Write a note"
state: review
owner: srini
provenance: human
created: 2026-08-19
links:
  implements: [RQ-0001]
  verified_by: [TC-0001]
---

# ST-0001 — Write a note

A scripted slice.

## Acceptance criteria

- [AC-1] notes.md contains a new line.
`;

/** One passing, one failing fence, each printing a marker before it exits — so "live output
 * appears" and "the failing command's output" both have something concrete to assert against. The
 * absolute `execPath` (not `node` on `PATH`) is what dodges PATH issues in the spawned shell. */
function checksPlaybook(execPath: string): string {
  return `---
type: Playbook
id: PB-0004
title: "Run the checks"
state: active
owner: Test Person
provenance: agent
created: 2026-08-20
generated: { by: "claude-code", at: 2026-08-20T00:00:00Z }
---

# PB-0004 — Run the checks

Run each of these and report what happened; the exit code is the whole verdict.

\`\`\`check
"${execPath}" -e "console.log('check one ran'); process.exit(0);"
\`\`\`

\`\`\`check
"${execPath}" -e "console.log('check two ran'); process.exit(1);"
\`\`\`
`;
}

async function open(
  options: { checks?: boolean } = {},
): Promise<{ app: ElectronApplication; w: Page; work: string }> {
  const config = mkdtempSync(join(tmpdir(), "checks-config-"));
  const work = mkdtempSync(join(tmpdir(), "checks-work-"));
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

  if (options.checks === false) {
    // The template ships a placeholder `check` fence (its command does not exist on purpose — see
    // pb-0004.md's own body) — removed here so this fixture is honestly a project with no checks.
    rmSync(join(work, "docs", "playbooks", "pb-0004.md"));
  } else {
    // The template's README already carries a PB-0004 row (`cpSync` copied it above); only the
    // artifact's own content needs replacing, from the placeholder to this fixture's real fences.
    writeFileSync(join(work, "docs", "playbooks", "pb-0004.md"), checksPlaybook(process.execPath));
  }

  // The template ships every other playbook with an unresolved `{{OWNER}}` token — `fillProject`
  // fills it in normally, and this fixture skips that, so it is filled in by hand, the same way
  // `playbooks.spec.ts` does. Left unresolved, `owner: {{OWNER}}` is not valid YAML. PB-0004 is
  // deliberately absent from this loop: the branch above either removed it or rewrote it whole.
  for (const id of ["pb-0001", "pb-0002", "pb-0003"]) {
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
        args: ["--experimental-strip-types", stub, "--mode=echo"],
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

async function openReview(w: Page): Promise<void> {
  // RQ-0045#AC-1, AC-3: Work is its own pinned surface now, not a nested strip view.
  await w.getByTestId("tab-work").click();
  await w.getByTestId("board-card-review-ST-0001").click();
  await expect(w.getByTestId("review-tab")).toBeVisible();
}

test("the checks run beside the review, live output arrives, and a failure goes to the agent", async () => {
  const { app, w } = await open();

  // A session ready before checks run, so handing a failure to the agent later delivers straight
  // through the always-mounted `Chat` rather than needing a second round trip through its tab.
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  await openReview(w);

  // AC-1: offered, because this project's record declares a checks playbook.
  const checks = w.getByTestId("checks");
  await expect(checks).toBeVisible();

  // AC-2: run them, and watch the output arrive live.
  await w.getByTestId("checks-run").click();
  const output = w.getByTestId("checks-output");
  await expect(output).toContainText("check one ran", { timeout: 15000 });
  await expect(output).toContainText("check two ran", { timeout: 15000 });

  // AC-3: each command's verdict, in words, once the run resolves.
  await expect(w.getByTestId("checks-result-0")).toContainText("passed", { timeout: 15000 });
  await expect(w.getByTestId("checks-result-1")).toContainText("failed", { timeout: 15000 });

  // AC-4: one press hands the failure to the agent, with its captured output.
  await w.getByTestId("checks-hand-to-agent").click();

  await w.getByTestId("tab-chat").click();
  const surface = w.locator(".copilotKitMessages");
  await expect(surface).toContainText("check two ran", { timeout: 20000 });
  await expect(surface).toContainText("failed", { timeout: 20000 });
  // Only the failing command's output, not the passing one's — the point of handing a *failure*.
  await expect(surface).not.toContainText("check one ran");

  await app.close();
});

test("a project with no checks playbook offers nothing", async () => {
  const { app, w } = await open({ checks: false });

  await openReview(w);

  await expect(w.getByTestId("checks")).toHaveCount(0);

  await app.close();
});

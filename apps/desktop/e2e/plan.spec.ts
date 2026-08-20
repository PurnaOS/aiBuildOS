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
const okfCli = fileURLToPath(new URL("../../../tools/okf/cli.ts", import.meta.url));

/**
 * TC-0047. A proposal lands as drafts, is shaped, and approval schedules it.
 *
 * Against the stub agent's `--mode=plan-writer`, which writes one scripted draft Story and TestCase
 * per requirement id named in the prompt. What is asserted is the application's half: picking starts
 * the playbook with the right context, the plan gathers what landed, retiring and approving are
 * ordinary guarded saves, and the result validates.
 */
async function open(): Promise<{ app: ElectronApplication; w: Page; work: string }> {
  const config = mkdtempSync(join(tmpdir(), "plan-config-"));
  const work = mkdtempSync(join(tmpdir(), "plan-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);
  cpSync(template, join(work, "docs"), { recursive: true });

  // The scaffold template leaves `owner` a token for `fillProject` to fill in (playbooks.spec.ts's
  // fixture does the same by hand): PB-0002 is what "Plan the selected work" starts.
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"), "utf8");
  }

  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ_1);
  writeFileSync(join(work, "docs/requirements/rq-0002.md"), RQ_2);
  const index = join(work, "docs/requirements/README.md");
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | The first thing | ready | — |\n` +
      `| [RQ-0002](rq-0002.md) | The second thing | ready | — |\n`,
  );

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=plan-writer"],
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
  // Retire's confirm is a plain `window.confirm` (TabStrip's own close pattern) — Playwright dismisses
  // an unhandled one, so this must be registered before anything that could trigger it.
  w.on("dialog", (dialog) => void dialog.accept());

  await w.getByTestId("project-open").first().click();
  await w.getByTestId("workspace").waitFor();
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });
  await w.getByTestId("tab-board").click();
  await w.getByTestId("board-tab").waitFor();

  return { app, w, work };
}

const RQ_1 = `---
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

const RQ_2 = `---
type: Requirement
id: RQ-0002
title: "The second thing"
state: ready
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0002 — The second thing

## Acceptance criteria

- [AC-1] It does the second thing.
`;

/** A draft Story RQ-0014#AC-7 needs: legal at `draft` (min waived), but not listed in its directory's
 * index — `index/listed` is an error at every state, so `project:record` marks it rejected before any
 * flip is even attempted. */
function rejectedStory(id: string): string {
  return `---
type: Story
id: ${id}
title: "Not in the index"
state: draft
owner: srini
provenance: human
created: 2026-08-19
links:
  implements: [RQ-0001]
---

# ${id} — Not in the index

## Acceptance criteria

- [AC-1] It does the thing.
`;
}

/** A draft Story that is otherwise legal but names no verifying test — RQ-0014#AC-6's case. */
function unverifiedStory(id: string): string {
  return `---
type: Story
id: ${id}
title: "No test yet"
state: draft
owner: srini
provenance: human
created: 2026-08-19
links:
  implements: [RQ-0001]
---

# ${id} — No test yet

## Acceptance criteria

- [AC-1] It does the thing.
`;
}

async function sendPrompt(w: Page, text: string): Promise<void> {
  await w.getByTestId("tab-chat").click();
  const composer = w.locator("textarea, [contenteditable=true]").first();
  await composer.click();
  await composer.fill(text);
  await w.keyboard.press("Enter");
}

test("a proposal lands as drafts, is shaped, and approval schedules it", async () => {
  const { app, w, work } = await open();

  // AC-1: picking on the Backlog starts the plan playbook with exactly the picked requirements.
  await expect(w.getByTestId("board-column-ready").getByTestId("board-card-RQ-0001")).toBeVisible();
  await expect(w.getByTestId("board-column-ready").getByTestId("board-card-RQ-0002")).toBeVisible();
  await w.getByTestId("plan-pick-RQ-0001").check();
  await w.getByTestId("plan-pick-RQ-0002").check();
  await w.getByTestId("plan-start").click();

  await w.getByTestId("tab-chat").click();
  const surface = w.locator(".copilotKitMessages");
  await expect(surface).toContainText("RQ-0001");
  await expect(surface).toContainText("RQ-0002");
  // The stub's own turn ending is the revision bump the plan and the banner both wait on.
  await expect(surface).toContainText("Proposed 2 draft stories.", { timeout: 20000 });

  // AC-2: the drafts are ordinary files a restart does not lose — asserted straight off disk.
  expect(readFileSync(join(work, "docs/user-stories/st-0001.md"), "utf8")).toContain(
    "implements: [RQ-0001]",
  );
  expect(readFileSync(join(work, "docs/user-stories/st-0002.md"), "utf8")).toContain(
    "implements: [RQ-0002]",
  );

  // AC-3: the banner offers the plan whenever draft work exists.
  await w.getByTestId("tab-board").click();
  await expect(w.getByTestId("plan-banner")).toContainText("4");
  await w.getByTestId("plan-banner-open").click();
  await expect(w.getByTestId("plan-tab")).toBeVisible();

  // Grouped under the requirement each story implements.
  const groupOne = w.getByTestId("plan-group-RQ-0001");
  const groupTwo = w.getByTestId("plan-group-RQ-0002");
  await expect(groupOne.getByTestId("plan-story-ST-0001")).toBeVisible();
  await expect(groupTwo.getByTestId("plan-story-ST-0002")).toBeVisible();

  // Expanding a row reads its ACs and its verifying test via `project:artifact`.
  await w.getByTestId("plan-story-toggle-ST-0001").click();
  await expect(w.getByTestId("plan-story-ac-ST-0001-1")).toContainText(
    "The behaviour RQ-0001 asks for is observable.",
  );
  await expect(w.getByTestId("plan-test-TC-0001")).toBeVisible();

  // AC-4/AC-3(ST-0027): a draft retires from the plan with the same tab-close-style confirm.
  await w.getByTestId("plan-story-retire-ST-0002").click();
  await expect(w.getByTestId("plan-story-ST-0002")).toHaveCount(0);
  expect(readFileSync(join(work, "docs/user-stories/st-0002.md"), "utf8")).toContain(
    "state: retired",
  );
  // TC-0002 verifies RQ-0002 directly (the stub's own link shape), so it survives its story's
  // retirement — proof the plan's grouping re-derives rather than caching what it first saw.
  await expect(groupTwo.getByTestId("plan-test-TC-0002")).toBeVisible();

  // AC-5: approve — one guarded save per artifact, stories to `ready`, tests to `active`.
  await expect(w.getByTestId("plan-approve-consequence")).toHaveText(
    "Marks 1 story ready and 2 tests active.",
  );
  await w.getByTestId("plan-approve").click();
  await expect(w.getByTestId("plan-empty")).toBeVisible({ timeout: 15000 });

  expect(readFileSync(join(work, "docs/user-stories/st-0001.md"), "utf8")).toContain(
    "state: ready",
  );
  expect(readFileSync(join(work, "docs/testing/tc-0001.md"), "utf8")).toContain("state: active");
  expect(readFileSync(join(work, "docs/testing/tc-0002.md"), "utf8")).toContain("state: active");
  // Untouched by the approval walk — retiring is not a flip this walk performs.
  expect(readFileSync(join(work, "docs/user-stories/st-0002.md"), "utf8")).toContain(
    "state: retired",
  );

  // The bundle this leaves behind is exactly what `docs:check` itself would accept.
  expect(() => execFileSync("bun", [okfCli, "docs"], { cwd: work })).not.toThrow();

  // RQ-0014#AC-6 and AC-7, seeded together after the clean checkpoint above rather than inside the
  // batch that produced it: ST-0099 has no verifying test, which is legal at `draft` (the profile
  // waives the `verified_by` minimum at a Story's initial state) but not at `ready` — its flip is
  // attempted and lands with a `link/cardinality` error, which this walk reverts by saving back to
  // `draft`. ST-0098 is missing from its directory's index, an error at *every* state, so it is
  // marked and its flip is never attempted at all — a different refusal, from a different rule.
  //
  // The revert needs `ready -> draft` to be a declared Story transition — building this test found
  // it missing (only Requirement had it), and the profile gained the pair for exactly this reason:
  // a refused approval must leave the story where approval found it, not stranded at `ready`
  // carrying the very error the refusal named.
  writeFileSync(join(work, "docs/user-stories/st-0098.md"), rejectedStory("ST-0098"));
  writeFileSync(join(work, "docs/user-stories/st-0099.md"), unverifiedStory("ST-0099"));
  const storiesIndex = join(work, "docs/user-stories/README.md");
  writeFileSync(
    storiesIndex,
    `${readFileSync(storiesIndex, "utf8")}| [ST-0099](st-0099.md) | No test yet | draft | [RQ-0001](../requirements/rq-0001.md) |\n`,
  );
  // ST-0098 is deliberately left out of the index — that omission is the validator error.

  // A turn with no requirement id in it still ends, which is all a revision bump needs.
  await sendPrompt(w, "continue");
  await expect(w.locator(".copilotKitMessages")).toContainText(
    "No requirement ids in the prompt.",
    {
      timeout: 20000,
    },
  );

  await w.getByTestId("tab-board").click();
  await expect(w.getByTestId("plan-banner")).toBeVisible();
  await w.getByTestId("plan-banner-open").click();

  // AC-7: the validator's own rejection is marked before anything is attempted.
  await expect(w.getByTestId("plan-story-rejected-ST-0098")).toBeVisible();
  await expect(w.getByTestId("plan-story-rejected-ST-0099")).toHaveCount(0);
  await expect(w.getByTestId("plan-approve-consequence")).toHaveText(
    "Marks 2 stories ready and 0 tests active.",
  );

  await w.getByTestId("plan-approve").click();
  // ST-0098's flip was never attempted: still `draft`, still in the view, still marked.
  await expect(w.getByTestId("plan-story-ST-0098")).toBeVisible({ timeout: 15000 });
  await expect(w.getByTestId("plan-story-rejected-ST-0098")).toBeVisible();
  expect(readFileSync(join(work, "docs/user-stories/st-0098.md"), "utf8")).toContain(
    "state: draft",
  );

  // ST-0099's flip was attempted, refused by the record's own cardinality rule, and reverted: back
  // at `draft`, still in the view, wearing the refusal (RQ-0014#AC-6).
  await expect(w.getByTestId("plan-story-ST-0099")).toBeVisible();
  await expect(w.getByTestId("plan-story-refusal-ST-0099")).toBeVisible();
  const st0099 = readFileSync(join(work, "docs/user-stories/st-0099.md"), "utf8");
  expect(st0099).toContain("state: draft");
  expect(st0099).not.toContain("verified_by");

  await app.close();
});

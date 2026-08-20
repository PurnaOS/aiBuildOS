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
 * TC-0065. A changed requirement offers the impact, and the re-plan — through the running
 * application.
 *
 * Against the stub agent's `--mode=echo`, which replies with exactly the prompt text it received —
 * the same proof `playbooks.spec.ts` reads a transcript with, here read for the plan playbook a
 * press starts with the changed requirement named as context.
 *
 * Verifies RQ-0024#AC-1, AC-3 and AC-4.
 */
const RQ = `---
type: Requirement
id: RQ-0001
title: "The first thing"
state: verified
owner: srini
provenance: human
created: 2026-08-19
kind: functional
---

# RQ-0001 — The first thing

## Acceptance criteria

- [AC-1] It does the thing.
`;

function story(id: string, title: string, state: string): string {
  return `---
type: Story
id: ${id}
title: "${title}"
state: ${state}
owner: srini
provenance: human
created: 2026-08-19
links:
  implements: [RQ-0001]
  verified_by: [TC-0001]
---

# ${id} — ${title}

## Acceptance criteria

- [AC-1] It does its part.
`;
}

const TC = `---
type: TestCase
id: TC-0001
title: "It works"
state: active
owner: srini
provenance: human
created: 2026-08-19
kind: manual
links:
  verifies: [RQ-0001]
---

# TC-0001 — It works

## Steps

1. Do the thing.
`;

async function open(): Promise<{ app: ElectronApplication; w: Page; work: string }> {
  const config = mkdtempSync(join(tmpdir(), "impact-config-"));
  const work = mkdtempSync(join(tmpdir(), "impact-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);

  cpSync(template, join(work, "docs"), { recursive: true });
  // The template ships `owner: {{OWNER}}` in its seed playbooks — only `seedBundle` resolves that,
  // which a raw `cpSync` does not run (findings.spec.ts's fixture does the same by hand).
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"), "utf8");
  }

  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ);
  writeFileSync(join(work, "docs/user-stories/st-0001.md"), story("ST-0001", "Done work", "done"));
  writeFileSync(
    join(work, "docs/user-stories/st-0002.md"),
    story("ST-0002", "Building work", "building"),
  );
  writeFileSync(join(work, "docs/testing/tc-0001.md"), TC);

  const rqIndex = join(work, "docs/requirements/README.md");
  writeFileSync(
    rqIndex,
    `${readFileSync(rqIndex, "utf8")}| [RQ-0001](rq-0001.md) | The first thing | verified | — |\n`,
  );
  const storyIndex = join(work, "docs/user-stories/README.md");
  writeFileSync(
    storyIndex,
    `${readFileSync(storyIndex, "utf8")}` +
      "| [ST-0001](st-0001.md) | Done work | done | [RQ-0001](../requirements/rq-0001.md) |\n" +
      "| [ST-0002](st-0002.md) | Building work | building | [RQ-0001](../requirements/rq-0001.md) |\n",
  );
  const testIndex = join(work, "docs/testing/README.md");
  writeFileSync(
    testIndex,
    `${readFileSync(testIndex, "utf8")}| [TC-0001](tc-0001.md) | It works | active | [RQ-0001](../requirements/rq-0001.md) |\n`,
  );

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

test("a saved edit past `ready` shows the impact, and starts the re-plan naming the requirement", async () => {
  const { app, w, work } = await open();

  // Chat is the tab a fresh workspace opens on — the same order `plan.spec.ts` starts a session in.
  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  await w.getByTestId("record-open-RQ-0001").click();
  await expect(w.getByTestId("artifact-tab")).toBeVisible();
  // Nothing shown yet: this sitting has not edited the requirement, only opened it (ST-0036).
  await expect(w.getByTestId("artifact-impact")).toHaveCount(0);

  // AC-1/AC-4: append a criterion — the edit that both triggers the save and proves append-only
  // safety in the same step.
  await w.getByTestId("criterion-add").click();
  await w.getByTestId("criterion-2").fill("The blast radius shows beside the editor.");
  await expect(w.getByTestId("artifact-saved")).toHaveText("saved", { timeout: 15000 });

  const after = readFileSync(join(work, "docs/requirements/rq-0001.md"), "utf8");
  expect(after).toContain("- [AC-1] It does the thing.");
  expect(after).toContain("- [AC-2] The blast radius shows beside the editor.");
  expect(() => execFileSync("bun", [okfCli, "docs"], { cwd: work })).not.toThrow();

  // AC-1/AC-2: told apart, each with its own state.
  await expect(w.getByTestId("artifact-impact")).toBeVisible();
  await expect(w.getByTestId("impact-done").getByTestId("impact-row-ST-0001")).toContainText(
    "(done)",
  );
  await expect(w.getByTestId("impact-in-flight").getByTestId("impact-row-ST-0002")).toContainText(
    "(building)",
  );
  await expect(
    w.getByTestId("impact-verification").getByTestId("impact-row-TC-0001"),
  ).toContainText("(active)");

  // AC-3: one press starts the plan playbook with the changed requirement as context.
  await w.getByTestId("impact-plan").click();

  await w.getByTestId("tab-chat").click();
  const surface = w.locator(".copilotKitMessages");
  // `--mode=echo` replies with exactly what it received, so the requirement lands twice: once as
  // the sent prompt, once as the agent's reply — proof of what the press actually sent.
  await expect
    .poll(async () => (await surface.innerText()).split("RQ-0001").length - 1, { timeout: 20000 })
    .toBeGreaterThanOrEqual(2);
  await expect(surface).toContainText("The first thing");

  await app.close();
});

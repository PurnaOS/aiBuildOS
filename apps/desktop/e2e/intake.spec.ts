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

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const template = fileURLToPath(new URL("../src/main/okf-template/docs", import.meta.url));
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));
const okfCli = fileURLToPath(new URL("../../../tools/okf/cli.ts", import.meta.url));

/**
 * TC-0053 / TC-0054. The interview drafts requirements as it settles them, and an abandoned one
 * keeps its drafts, as drafts.
 *
 * Against the stub agent's `--mode=interview`: turns 1 and 2 each ask one fenced question, every
 * turn from 3 onward writes one draft Requirement straight into the record with its index row and
 * announces it — the shape a real interview produces, minus the judgement.
 */
async function open(
  seed?: (work: string) => void,
): Promise<{ app: ElectronApplication; w: Page; work: string }> {
  const config = mkdtempSync(join(tmpdir(), "intake-config-"));
  const work = mkdtempSync(join(tmpdir(), "intake-work-"));
  execFileSync("git", ["-C", work, "init", "--quiet"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test Person"]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);
  cpSync(template, join(work, "docs"), { recursive: true });

  // The scaffold template leaves `owner` a token for `fillProject` to fill in — a raw `cpSync` never
  // runs that, and an unresolved `{{OWNER}}` fails every playbook's own `doc/field-required` check.
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"), "utf8");
  }

  seed?.(work);

  writeFileSync(
    join(config, "harnesses.json"),
    JSON.stringify([
      {
        id: "h",
        displayName: "Stub",
        command: process.execPath,
        args: ["--experimental-strip-types", stub, "--mode=interview"],
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

async function startIdea(w: Page, idea: string): Promise<void> {
  await w.getByTestId("playbook-PB-0001").click();
  await w.getByTestId("playbook-idea-input-PB-0001").fill(idea);
  await w.getByTestId("playbook-idea-start-PB-0001").click();
}

function seedRequirement(work: string, id: string, content: string, title: string): void {
  writeFileSync(join(work, "docs/requirements", `${id.toLowerCase()}.md`), content);
  const index = join(work, "docs/requirements/README.md");
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [${id}](${id.toLowerCase()}.md) | ${title} | draft | — |\n`,
  );
}

const SEEDED_DRAFT = `---
type: Requirement
id: RQ-0001
title: "Already landed from an earlier interview"
state: draft
owner: srini
provenance: agent
created: 2026-08-19
kind: functional
---

# RQ-0001 — Already landed from an earlier interview

## Acceptance criteria

- [AC-1] The settled behaviour is observable.
`;

/** Invalid on purpose, the shape the stub's own interview writes but missing `kind` — the profile
 * requires it on a Requirement (the same defect findings.spec.ts's RQ-0012 coverage uses). */
const INVALID_DRAFT = `---
type: Requirement
id: RQ-0001
title: "What the interview settled"
state: draft
owner: srini
provenance: agent
created: 2026-08-20
---

# RQ-0001 — What the interview settled

## Acceptance criteria

- [AC-1] The settled behaviour is observable.
`;

test("the interview drafts requirements as it settles them", async () => {
  const { app, w, work } = await open();
  const surface = w.locator(".copilotKitMessages");

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  // AC-1: intake starts from whatever was typed, carried alongside the playbook's own instructions.
  await startIdea(w, "A notes app for splitting bills with roommates.");
  const sent = w.locator(".copilotKitUserMessage").last();
  await expect(sent).toContainText("A notes app for splitting bills with roommates.");
  await expect(sent).toContainText("Interview me about this idea, one question at a time");

  // AC-2: the interview's questions arrive one at a time, as cards.
  const first = w.getByTestId("question-card").last();
  await expect(first).toContainText("Who is this for?");
  await first.getByTestId("question-option-me").click();

  const second = w.getByTestId("question-card").last();
  await expect(second).toContainText("What must work first?");
  await second.getByTestId("question-option-save").click();

  // AC-3: what settles is written as a draft, on the backlog by the turn that wrote it.
  await expect(surface).toContainText("Added RQ-0001 to the list.", { timeout: 20000 });
  expect(readFileSync(join(work, "docs/requirements/rq-0001.md"), "utf8")).toContain(
    "state: draft",
  );

  await w.getByTestId("tab-board").click();
  await expect(w.getByTestId("board-column-draft").getByTestId("board-card-RQ-0001")).toBeVisible();

  // The bundle this leaves behind is exactly what `docs:check` itself would accept.
  expect(() => execFileSync("bun", [okfCli, "docs"], { cwd: work })).not.toThrow();

  // AC-6: the door reopens against the same record, numbering onward.
  await w.getByTestId("tab-chat").click();
  await startIdea(w, "A second idea, entered later.");
  await expect(surface).toContainText("Added RQ-0002 to the list.", { timeout: 20000 });
  expect(readFileSync(join(work, "docs/requirements/rq-0002.md"), "utf8")).toContain(
    "state: draft",
  );

  await w.getByTestId("tab-board").click();
  await expect(w.getByTestId("board-column-draft").getByTestId("board-card-RQ-0002")).toBeVisible();

  await app.close();
});

test("stopping mid-interview keeps drafts already written, as drafts", async () => {
  const { app, w, work } = await open((dir) =>
    seedRequirement(dir, "RQ-0001", SEEDED_DRAFT, "Already landed from an earlier interview"),
  );

  await w.getByTestId("start-h").click();
  await w.getByTestId("chat").waitFor({ timeout: 20000 });

  await startIdea(w, "An idea, abandoned partway through.");
  const first = w.getByTestId("question-card").last();
  await expect(first).toContainText("Who is this for?");
  await first.getByTestId("question-option-me").click();

  // The second question lands and is left unanswered — the stub's writing turn is turn three, and
  // it never runs (RQ-0017#AC-4).
  const second = w.getByTestId("question-card").last();
  await expect(second).toContainText("What must work first?");

  await w.getByTestId("tab-board").click();
  await expect(w.getByTestId("board-column-draft").getByTestId("board-card-RQ-0001")).toBeVisible();
  expect(readFileSync(join(work, "docs/requirements/rq-0001.md"), "utf8")).toBe(SEEDED_DRAFT);
  expect(existsSync(join(work, "docs/requirements/rq-0002.md"))).toBe(false);

  // Nothing about the app is stuck: the record is still browsable and the door still works.
  await w.getByTestId("tab-chat").click();
  await expect(w.getByTestId("chat")).toBeVisible();
  await expect(w.getByTestId("playbook-PB-0001")).toBeEnabled();

  await app.close();
});

test("a draft the validator rejects is marked, and the rest of the record stays usable", async () => {
  // RQ-0017#AC-5 — the mark is `record-problems-<id>`, the one RQ-0012 already put on the rail
  // (findings.spec.ts), exercised here against a draft shaped exactly like the interview's own.
  const { app, w } = await open((dir) =>
    seedRequirement(dir, "RQ-0001", INVALID_DRAFT, "What the interview settled"),
  );

  const mark = w.getByTestId("record-problems-RQ-0001");
  await expect(mark).toBeVisible();
  await expect(mark).toContainText("error");

  await expect(w.getByTestId("record-open-PB-0001")).toBeVisible();
  await expect(w.getByTestId("record-rail")).toBeVisible();

  await app.close();
});

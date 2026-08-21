import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "@aibuildos/knowledge-engine";
import { loadBundle, loadProfile } from "@aibuildos/knowledge-engine/load";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git } from "./git.js";
import { landPlan, recordVerdict } from "./typedRecord.js";

/**
 * TC-0121/TC-0122's main-process half: a typed plan lands as draft artifacts through the
 * knowledge engine, a non-conforming or record-breaking one is rejected back as findings with
 * nothing written, and a typed verdict persists through the same guarded save the manual walk
 * uses. Against a real project seeded from the OKF template (builds.test.ts's fixture), so the
 * validation that accepts or rejects a plan is the genuine profile's.
 */
const template = fileURLToPath(new URL("./okf-template/docs", import.meta.url));

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

async function seedProject(): Promise<string> {
  const work = mkdtempSync(join(tmpdir(), "aibuildos-typed-record-"));
  await git(work, "init", "--quiet");
  await git(work, "config", "user.name", "Test Person");
  await git(work, "config", "user.email", "test@example.com");
  cpSync(template, join(work, "docs"), { recursive: true });
  for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
    const file = join(work, "docs", "playbooks", `${id}.md`);
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("{{OWNER}}", "Test Person"), "utf8");
  }
  writeFileSync(join(work, "docs/requirements/rq-0001.md"), RQ_1);
  const index = join(work, "docs/requirements/README.md");
  writeFileSync(
    index,
    `${readFileSync(index, "utf8")}| [RQ-0001](rq-0001.md) | The first thing | ready | — |\n`,
  );
  return work;
}

/** The plan the typed-record stub proposes for one requirement — the conforming shape. */
function plan(): unknown {
  return {
    sessionId: "stub-session",
    _meta: { "aibuildos/typed-record": { attempt: 1 } },
    stories: [
      {
        title: "Deliver RQ-0001",
        implements: ["RQ-0001"],
        criteria: ["The behaviour RQ-0001 asks for is observable."],
      },
    ],
    testCases: [
      {
        title: "RQ-0001 behaves as asked",
        kind: "automated",
        verifies: ["RQ-0001"],
        steps: ["Exercise RQ-0001 and expect what it promises."],
      },
    ],
  };
}

describe("landing a typed plan", () => {
  let work: string;

  beforeEach(async () => {
    work = await seedProject();
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("lands a conforming plan as draft artifacts the record validates clean", async () => {
    const response = await landPlan(work, "stub-agent", plan());
    expect(response).toEqual({ accepted: true, ids: ["ST-0001", "TC-0001"] });

    const story = readFileSync(join(work, "docs/user-stories/st-0001.md"), "utf8");
    expect(story).toContain("implements: [RQ-0001]");
    expect(story).toContain("verified_by: [TC-0001]");
    expect(story).toContain("state: draft");
    // Agent-authored, and the record says so (okf-conventions §2).
    expect(story).toContain("provenance: agent");
    expect(story).toContain('generated: { by: "stub-agent"');
    expect(story).toContain("- [AC-1] The behaviour RQ-0001 asks for is observable.");

    const test = readFileSync(join(work, "docs/testing/tc-0001.md"), "utf8");
    expect(test).toContain("verifies: [RQ-0001]");
    expect(test).toContain("kind: automated");

    // Indexed with it — an artifact missing from its index is a validation error.
    expect(readFileSync(join(work, "docs/user-stories/README.md"), "utf8")).toContain(
      "[ST-0001](st-0001.md)",
    );
    expect(readFileSync(join(work, "docs/testing/README.md"), "utf8")).toContain(
      "[TC-0001](tc-0001.md)",
    );

    // The bundle left behind is one `validate()` itself accepts.
    const root = join(work, "docs");
    const findings = validate(loadBundle(root, work).bundle, loadProfile(root).profile);
    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("rejects a non-conforming payload with schema findings, writing nothing", async () => {
    const broken = plan() as { stories: { title: string }[] };
    if (broken.stories[0]) broken.stories[0].title = "";

    const response = await landPlan(work, "stub-agent", broken);
    expect(response.accepted).toBe(false);
    if (response.accepted) return;
    expect(response.findings[0]?.rule).toBe("plan/schema");
    expect(response.findings[0]?.message).toContain("stories.0.title");
    expect(existsSync(join(work, "docs/user-stories/st-0001.md"))).toBe(false);
  });

  it("rejects a conforming payload the record's own rules refuse, writing nothing", async () => {
    // Shape-valid, record-invalid: RQ-9999 is a well-formed id that is not in this bundle, so the
    // reject-back carries the validator's finding rather than a schema one.
    const dangling = plan() as { stories: { implements: string[] }[] };
    if (dangling.stories[0]) dangling.stories[0].implements = ["RQ-9999"];

    const response = await landPlan(work, "stub-agent", dangling);
    expect(response.accepted).toBe(false);
    if (response.accepted) return;
    expect(response.findings.map((finding) => finding.message).join(" ")).toContain("RQ-9999");
    expect(existsSync(join(work, "docs/user-stories/st-0001.md"))).toBe(false);
    expect(readFileSync(join(work, "docs/user-stories/README.md"), "utf8")).not.toContain(
      "ST-0001",
    );
  });

  it("mints past what the bundle already holds, never reusing a number", async () => {
    writeFileSync(
      join(work, "docs/user-stories/st-0007.md"),
      `---\ntype: Story\nid: ST-0007\ntitle: "Taken"\nstate: draft\nowner: srini\nprovenance: human\ncreated: 2026-08-19\nlinks:\n  implements: [RQ-0001]\n---\n\n# ST-0007 — Taken\n\n## Acceptance criteria\n\n- [AC-1] Held.\n`,
    );
    const index = join(work, "docs/user-stories/README.md");
    writeFileSync(
      index,
      `${readFileSync(index, "utf8")}| [ST-0007](st-0007.md) | Taken | draft | — |\n`,
    );

    const response = await landPlan(work, "stub-agent", plan());
    expect(response).toMatchObject({ accepted: true, ids: ["ST-0008", "TC-0001"] });
  });
});

describe("recording a typed verdict", () => {
  let work: string;

  beforeEach(async () => {
    work = await seedProject();
    // A TestCase to report against — landed the same way a typed plan lands one.
    await landPlan(work, "stub-agent", plan());
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("persists through the guarded save, the way the manual walk does", () => {
    const problem = recordVerdict(work, "Stub", {
      testCaseId: "TC-0001",
      result: "passed",
      ranAt: "2026-08-20T00:00:00Z",
    });
    expect(problem).toBeNull();

    const test = readFileSync(join(work, "docs/testing/tc-0001.md"), "utf8");
    expect(test).toContain("last_result: passed");
    expect(test).toContain("last_run: 2026-08-20T00:00:00Z");
    expect(test).toContain("last_run_by: Stub");
  });

  it("drops an invalid payload with the problem to narrate, touching nothing", () => {
    const before = readFileSync(join(work, "docs/testing/tc-0001.md"), "utf8");
    const problem = recordVerdict(work, "Stub", {
      testCaseId: "TC-0001",
      result: "vibes",
      ranAt: "2026-08-20T00:00:00Z",
    });
    expect(problem).toContain("not a typed verdict");
    expect(readFileSync(join(work, "docs/testing/tc-0001.md"), "utf8")).toBe(before);
  });

  it("reports a TestCase that is not in the record", () => {
    const problem = recordVerdict(work, "Stub", {
      testCaseId: "TC-0099",
      result: "failed",
      ranAt: "2026-08-20T00:00:00Z",
    });
    expect(problem).toContain("TC-0099");
  });

  it("persists nothing for could_not_run — exit codes stay the truth for what ran", () => {
    const before = readFileSync(join(work, "docs/testing/tc-0001.md"), "utf8");
    const problem = recordVerdict(work, "Stub", {
      testCaseId: "TC-0001",
      result: "could_not_run",
      ranAt: "2026-08-20T00:00:00Z",
    });
    expect(problem).toBeNull();
    expect(readFileSync(join(work, "docs/testing/tc-0001.md"), "utf8")).toBe(before);
  });
});

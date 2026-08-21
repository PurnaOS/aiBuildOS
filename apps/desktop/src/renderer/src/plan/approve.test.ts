import { describe, expect, it } from "vitest";
import { approve, describeApproval, flipsFor } from "./approve.js";
import { derivePlan, type RecordEntry } from "./derive.js";

/**
 * TC-0046. Approval flips what it may, and refuses what the record's rules refuse.
 *
 * Verifies RQ-0014#AC-3, AC-5 and AC-6 as logic: the derivation of the plan view from a record, and
 * the walk of flips an approval performs, against an injected fake save.
 */
const CLEAN = { errors: 0, warnings: 0 };

function requirement(id: string, inbound: RecordEntry["inbound"] = []): RecordEntry {
  return {
    id,
    type: "Requirement",
    title: `Requirement ${id}`,
    state: "ready",
    problems: CLEAN,
    inbound,
  };
}

function story(id: string, inbound: RecordEntry["inbound"] = [], problems = CLEAN): RecordEntry {
  return { id, type: "Story", title: `Story ${id}`, state: "draft", problems, inbound };
}

function test_(id: string, inbound: RecordEntry["inbound"] = [], problems = CLEAN): RecordEntry {
  return { id, type: "TestCase", title: `Test ${id}`, state: "draft", problems, inbound };
}

describe("deriving the plan from a record", () => {
  it("groups drafts by requirement and orders both requirements and stories by dependency then ID", () => {
    // RQ-0004 depends_on RQ-0007 (stored on RQ-0004, so it arrives as inbound `depends_on` on
    // RQ-0007) — ID order alone would put RQ-0004 first, so this is the case that tells dependency
    // order apart from a plain ID sort rather than agreeing with it by coincidence.
    const artifacts: RecordEntry[] = [
      requirement("RQ-0004", [{ relationship: "implements", id: "ST-0002" }]),
      requirement("RQ-0007", [
        { relationship: "implements", id: "ST-0009" },
        { relationship: "depends_on", id: "RQ-0004" },
      ]),
      story("ST-0002", [{ relationship: "verifies", id: "TC-0001" }]),
      story("ST-0009"),
      test_("TC-0001"),
    ];

    const groups = derivePlan(artifacts);

    expect(groups.map((g) => g.requirementId)).toEqual(["RQ-0007", "RQ-0004"]);
    expect(groups[0]?.stories.map((s) => s.id)).toEqual(["ST-0009"]);
    expect(groups[1]?.stories.map((s) => s.id)).toEqual(["ST-0002"]);
    expect(groups[1]?.stories[0]?.tests.map((t) => t.id)).toEqual(["TC-0001"]);
  });

  it("orders two stories under the same requirement by dependency before ID", () => {
    // ST-0002 depends_on ST-0009 (inbound `depends_on` on ST-0009): topological order reads
    // ST-0009 first, which a plain ID sort would get backwards.
    const artifacts: RecordEntry[] = [
      requirement("RQ-0001", [
        { relationship: "implements", id: "ST-0002" },
        { relationship: "implements", id: "ST-0009" },
      ]),
      story("ST-0002"),
      story("ST-0009", [{ relationship: "depends_on", id: "ST-0002" }]),
    ];

    expect(derivePlan(artifacts)[0]?.stories.map((s) => s.id)).toEqual(["ST-0009", "ST-0002"]);
  });

  it("falls back to ID order when nothing declares a dependency", () => {
    const artifacts: RecordEntry[] = [
      requirement("RQ-0002", [{ relationship: "implements", id: "ST-0002" }]),
      requirement("RQ-0001", [{ relationship: "implements", id: "ST-0001" }]),
      story("ST-0001"),
      story("ST-0002"),
    ];

    expect(derivePlan(artifacts).map((g) => g.requirementId)).toEqual(["RQ-0001", "RQ-0002"]);
  });

  it("nests a test under its story by either stored direction, and leaves an unclaimed test on the requirement", () => {
    const artifacts: RecordEntry[] = [
      requirement("RQ-0001", [
        { relationship: "implements", id: "ST-0001" },
        { relationship: "verifies", id: "TC-0003" },
      ]),
      story("ST-0001", [{ relationship: "verifies", id: "TC-0001" }]),
      test_("TC-0001"),
      // TC-0002 verifies nothing itself; ST-0001's own `verified_by` claims it instead.
      test_("TC-0002", [{ relationship: "verified_by", id: "ST-0001" }]),
      test_("TC-0003"),
    ];

    const groups = derivePlan(artifacts);
    expect(groups[0]?.stories[0]?.tests.map((t) => t.id)).toEqual(["TC-0001", "TC-0002"]);
    expect(groups[0]?.tests.map((t) => t.id)).toEqual(["TC-0003"]);
  });

  it("marks a draft the validator already flags, and ignores an artifact that is not draft", () => {
    const artifacts: RecordEntry[] = [
      requirement("RQ-0001", [
        { relationship: "implements", id: "ST-0001" },
        // ST-0002 already implements RQ-0001 too, but it is past `draft` — the plan is not this
        // requirement's whole implementation history, only what is still waiting for review.
        { relationship: "implements", id: "ST-0002" },
      ]),
      story("ST-0001", [], { errors: 1, warnings: 0 }),
      { ...story("ST-0002"), state: "ready" },
    ];

    const groups = derivePlan(artifacts);
    expect(groups[0]?.stories.map((s) => s.id)).toEqual(["ST-0001"]);
    expect(groups[0]?.stories[0]?.rejected).toBe(true);
  });

  it("omits a requirement with no draft work under it", () => {
    const artifacts: RecordEntry[] = [requirement("RQ-0001")];
    expect(derivePlan(artifacts)).toEqual([]);
  });
});

describe("the approval walk", () => {
  const flip = async (
    outcomes: Record<
      string,
      { problem?: string; findings?: { severity: string; message: string }[] }
    >,
  ) => {
    const calls: { id: string; state: string }[] = [];
    const save = async (id: string, state: string) => {
      calls.push({ id, state });
      const outcome = outcomes[id] ?? {};
      return { problem: outcome.problem ?? null, findings: outcome.findings ?? [] };
    };
    return { save, calls };
  };

  it("flips every valid draft through the guarded save — stories to ready, tests to active", async () => {
    const artifacts: RecordEntry[] = [
      requirement("RQ-0001", [{ relationship: "implements", id: "ST-0001" }]),
      story("ST-0001", [{ relationship: "verifies", id: "TC-0001" }]),
      test_("TC-0001"),
    ];
    const flips = flipsFor(derivePlan(artifacts));
    const { save, calls } = await flip({});

    const outcomes = await approve(flips, save);

    expect(outcomes).toEqual([
      { id: "ST-0001", flipped: true, refusal: null },
      { id: "TC-0001", flipped: true, refusal: null },
    ]);
    expect(calls).toEqual([
      { id: "ST-0001", state: "ready" },
      { id: "TC-0001", state: "active" },
    ]);
  });

  it("reverts and refuses a story whose save lands with an error finding, and still flips the rest", async () => {
    const artifacts: RecordEntry[] = [
      requirement("RQ-0001", [
        { relationship: "implements", id: "ST-0001" },
        { relationship: "implements", id: "ST-0002" },
      ]),
      // ST-0001 has no verifying test — the record's rules refuse its flip to `ready`.
      story("ST-0001"),
      story("ST-0002", [{ relationship: "verifies", id: "TC-0002" }]),
      test_("TC-0002"),
    ];
    const flips = flipsFor(derivePlan(artifacts));
    const { save, calls } = await flip({
      "ST-0001": {
        findings: [{ severity: "error", message: "ST-0001 needs at least one verified_by" }],
      },
    });

    const outcomes = await approve(flips, save);

    expect(outcomes.find((o) => o.id === "ST-0001")).toEqual({
      id: "ST-0001",
      flipped: false,
      refusal: "ST-0001 needs at least one verified_by",
    });
    // Reverted: the failed flip's save is followed by a save back to draft.
    expect(calls.filter((c) => c.id === "ST-0001")).toEqual([
      { id: "ST-0001", state: "ready" },
      { id: "ST-0001", state: "draft" },
    ]);
    // The rest of the plan is not held hostage by ST-0001's refusal.
    expect(outcomes.find((o) => o.id === "ST-0002")).toEqual({
      id: "ST-0002",
      flipped: true,
      refusal: null,
    });
    expect(outcomes.find((o) => o.id === "TC-0002")).toEqual({
      id: "TC-0002",
      flipped: true,
      refusal: null,
    });
  });

  it("skips a pre-marked invalid draft with a reason, without attempting a save", async () => {
    const artifacts: RecordEntry[] = [
      requirement("RQ-0001", [
        { relationship: "implements", id: "ST-0001" },
        { relationship: "implements", id: "ST-0002" },
      ]),
      story("ST-0001", [], { errors: 1, warnings: 0 }),
      story("ST-0002"),
    ];
    const flips = flipsFor(derivePlan(artifacts));
    const { save, calls } = await flip({});

    const outcomes = await approve(flips, save);

    expect(outcomes.find((o) => o.id === "ST-0001")).toEqual({
      id: "ST-0001",
      flipped: false,
      refusal: "The validator already flags this draft; fix it before approving.",
    });
    expect(calls.some((c) => c.id === "ST-0001")).toBe(false);
    expect(outcomes.find((o) => o.id === "ST-0002")?.flipped).toBe(true);
  });

  it("leaves a draft in place, with the reason shown, when the save itself returns a problem", async () => {
    const artifacts: RecordEntry[] = [
      requirement("RQ-0001", [{ relationship: "implements", id: "ST-0001" }]),
      story("ST-0001"),
    ];
    const flips = flipsFor(derivePlan(artifacts));
    const { save } = await flip({ "ST-0001": { problem: "That transition is not legal." } });

    const outcomes = await approve(flips, save);
    expect(outcomes).toEqual([
      { id: "ST-0001", flipped: false, refusal: "That transition is not legal." },
    ]);
  });
});

describe("describing what approval will do", () => {
  it("counts stories and tests separately, singular and plural", () => {
    expect(describeApproval([])).toBe("Marks 0 stories ready and 0 tests active.");
    expect(describeApproval([{ id: "ST-0001", toState: "ready", rejected: false }])).toBe(
      "Marks 1 story ready and 0 tests active.",
    );
    expect(
      describeApproval([
        { id: "ST-0001", toState: "ready", rejected: false },
        { id: "TC-0001", toState: "active", rejected: false },
        { id: "TC-0002", toState: "active", rejected: false },
      ]),
    ).toBe("Marks 1 story ready and 2 tests active.");
  });
});

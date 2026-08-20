import { describe, expect, it } from "vitest";
import { deriveImpact, type RecordEntry } from "./impact.js";

/**
 * TC-0064. Impact is a read of the graph, grouped by what it means.
 *
 * Verifies RQ-0024#AC-1 and AC-2 as a pure derivation from a record's inbound links and states.
 */
describe("deriving a requirement's impact", () => {
  const REQUIREMENT: RecordEntry = {
    id: "RQ-0024",
    type: "Requirement",
    title: "When a requirement changes",
    state: "building",
    inbound: [
      { relationship: "implements", id: "ST-0001" },
      { relationship: "implements", id: "ST-0002" },
      { relationship: "implements", id: "ST-0003" },
      { relationship: "implements", id: "EP-0005" },
      { relationship: "verifies", id: "TC-0064" },
    ],
  };

  const DONE_STORY: RecordEntry = {
    id: "ST-0001",
    type: "Story",
    title: "Done work",
    state: "done",
    inbound: [],
  };
  const BUILDING_STORY: RecordEntry = {
    id: "ST-0002",
    type: "Story",
    title: "In-progress work",
    state: "building",
    inbound: [],
  };
  const DRAFT_STORY: RecordEntry = {
    id: "ST-0003",
    type: "Story",
    title: "Barely started",
    state: "draft",
    inbound: [],
  };
  const EPIC: RecordEntry = {
    id: "EP-0005",
    type: "Epic",
    title: "Grouping, not work",
    state: "active",
    inbound: [],
  };
  const TEST: RecordEntry = {
    id: "TC-0064",
    type: "TestCase",
    title: "Impact is a read of the graph",
    state: "active",
    inbound: [],
  };

  it("groups done, building and draft implementers apart from an active verifier", () => {
    const impact = deriveImpact(
      [REQUIREMENT, DONE_STORY, BUILDING_STORY, DRAFT_STORY, EPIC, TEST],
      "RQ-0024",
    );

    expect(impact.done).toEqual([{ id: "ST-0001", title: "Done work", state: "done" }]);
    // `building` and `draft` are both short of `accepted`/`done`, so both land in flight — the
    // honest bucket for a state that has not finished, unknown or not (AC-2).
    expect(impact.inFlight).toEqual([
      { id: "ST-0002", title: "In-progress work", state: "building" },
      { id: "ST-0003", title: "Barely started", state: "draft" },
    ]);
    expect(impact.verification).toEqual([
      { id: "TC-0064", title: "Impact is a read of the graph", state: "active" },
    ]);
    // The epic implements the requirement too, by theme — but grouping is not work, so it never
    // appears in any group.
    expect([...impact.done, ...impact.inFlight, ...impact.verification]).not.toContainEqual(
      expect.objectContaining({ id: "EP-0005" }),
    );
  });

  it("answers empty, not hidden, for a requirement nothing implements", () => {
    const untouched: RecordEntry = { ...REQUIREMENT, id: "RQ-0099", inbound: [] };

    expect(deriveImpact([untouched], "RQ-0099")).toEqual({
      done: [],
      inFlight: [],
      verification: [],
    });
  });

  it("groups an unknown state as in flight, and a Bug implementer counts as work", () => {
    const bug: RecordEntry = {
      id: "BG-0009",
      type: "Bug",
      title: "A fix in flight",
      state: "somewhere-new",
      inbound: [],
    };
    const requirement: RecordEntry = {
      ...REQUIREMENT,
      id: "RQ-0100",
      inbound: [{ relationship: "implements", id: "BG-0009" }],
    };

    const impact = deriveImpact([requirement, bug], "RQ-0100");

    expect(impact.done).toEqual([]);
    expect(impact.inFlight).toEqual([
      { id: "BG-0009", title: "A fix in flight", state: "somewhere-new" },
    ]);
  });
});

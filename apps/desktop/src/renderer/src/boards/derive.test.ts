import { describe, expect, it } from "vitest";
import {
  type BoardArtifact,
  deriveBoard,
  filterBySprint,
  mergeVocabularies,
  sprintProgress,
  sprintsOf,
} from "./derive.js";

/**
 * TC-0040. A board is a derivation of the record, and nothing else.
 *
 * Verifies RQ-0011#AC-1, AC-5 and AC-8 as a pure function from a loaded record to columns of cards —
 * same input, same output, always, since there is nothing else the output could depend on.
 */
const VOCAB = ["draft", "ready", "building", "built", "verified", "retired"];

const record: BoardArtifact[] = [
  { id: "RQ-0003", type: "Requirement", title: "Third", state: "draft", priority: "p2" },
  { id: "RQ-0001", type: "Requirement", title: "First", state: "draft", priority: "p1" },
  { id: "RQ-0002", type: "Requirement", title: "Second", state: "draft" },
  { id: "RQ-0004", type: "Requirement", title: "Fourth", state: "ready", priority: "p3" },
];

describe("deriveBoard", () => {
  it("makes one column per vocabulary state, in vocabulary order", () => {
    const columns = deriveBoard(record, VOCAB);
    expect(columns.map((c) => c.state)).toEqual(VOCAB);
  });

  it("puts every artifact in the column its state names", () => {
    const columns = deriveBoard(record, VOCAB);
    const draft = columns.find((c) => c.state === "draft");
    expect(draft?.cards.map((c) => c.id)).toEqual(["RQ-0001", "RQ-0003", "RQ-0002"]);
    const ready = columns.find((c) => c.state === "ready");
    expect(ready?.cards.map((c) => c.id)).toEqual(["RQ-0004"]);
    expect(columns.find((c) => c.state === "building")?.cards).toEqual([]);
  });

  it("orders each column by priority then ID — p1 before p2 before p3 before absent, then ID", () => {
    const columns = deriveBoard(record, VOCAB);
    const draft = columns.find((c) => c.state === "draft");
    // RQ-0001 (p1) < RQ-0003 (p2) < RQ-0002 (no priority, sorts last).
    expect(draft?.cards.map((c) => c.id)).toEqual(["RQ-0001", "RQ-0003", "RQ-0002"]);
  });

  it("is deterministic: the same input produces the same output every time", () => {
    expect(deriveBoard(record, VOCAB)).toEqual(deriveBoard(record, VOCAB));
  });

  it("surfaces an artifact whose state is outside the vocabulary, rather than dropping it", () => {
    const withStray: BoardArtifact[] = [
      ...record,
      { id: "RQ-0009", type: "Requirement", title: "Odd one", state: "archived" },
    ];
    const columns = deriveBoard(withStray, VOCAB);
    const trailing = columns[columns.length - 1];
    expect(trailing?.state).toBe("archived");
    expect(trailing?.cards.map((c) => c.id)).toEqual(["RQ-0009"]);
    // Nothing else moved: the vocabulary's own columns are still exactly the vocabulary, in order.
    expect(columns.slice(0, VOCAB.length).map((c) => c.state)).toEqual(VOCAB);
  });
});

describe("mergeVocabularies", () => {
  it("keeps the first list's order and appends only what the second adds", () => {
    expect(mergeVocabularies(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });
});

/** RQ-0035#AC-5, TC-0092: the Work header's sprint selector is a filter, derived from the same
 * inbound edges `project:record` already answers with — no separate sprint-membership fetch. */
describe("sprintsOf", () => {
  it("reads sprint membership off the inbound `contains` edges, and nothing else", () => {
    expect(
      sprintsOf([
        { relationship: "contains", id: "SP-0001" },
        { relationship: "implements", id: "EP-0001" },
      ]),
    ).toEqual(["SP-0001"]);
  });

  it("is empty for a card no sprint reaches", () => {
    expect(sprintsOf([{ relationship: "implements", id: "EP-0001" }])).toEqual([]);
  });
});

const ST_A: BoardArtifact = { id: "ST-0001", type: "Story", title: "A", state: "ready" };
const ST_B: BoardArtifact = { id: "ST-0002", type: "Story", title: "B", state: "accepted" };
const ST_C: BoardArtifact = { id: "ST-0003", type: "Story", title: "C", state: "ready" };
const membership = new Map<string, readonly string[]>([
  ["ST-0001", ["SP-0001"]],
  ["ST-0002", ["SP-0001"]],
]);

describe("filterBySprint", () => {
  it("`all` changes nothing", () => {
    expect(filterBySprint([ST_A, ST_B, ST_C], membership, "all")).toEqual([ST_A, ST_B, ST_C]);
  });

  it("`backlog` is every card no sprint's `contains` reaches", () => {
    expect(filterBySprint([ST_A, ST_B, ST_C], membership, "backlog")).toEqual([ST_C]);
  });

  it("a sprint id is only the cards that sprint reaches", () => {
    expect(filterBySprint([ST_A, ST_B, ST_C], membership, "SP-0001")).toEqual([ST_A, ST_B]);
  });

  it("an unknown sprint id reaches nothing, rather than falling back to `all`", () => {
    expect(filterBySprint([ST_A, ST_B, ST_C], membership, "SP-9999")).toEqual([]);
  });
});

describe("sprintProgress", () => {
  it("counts accepted over the total it is handed", () => {
    expect(sprintProgress([ST_A, ST_B])).toEqual({ accepted: 1, total: 2 });
  });

  it("is 0/0 for an empty sprint", () => {
    expect(sprintProgress([])).toEqual({ accepted: 0, total: 0 });
  });
});

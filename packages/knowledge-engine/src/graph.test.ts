import { describe, expect, it } from "vitest";
import { ArtifactGraph } from "./graph.js";

const graph = new ArtifactGraph([
  { id: "RQ-0001", type: "Requirement", links: {} },
  { id: "ST-0001", type: "Story", links: { implements: ["RQ-0001"], verified_by: ["TC-0001"] } },
  { id: "TC-0001", type: "TestCase", links: { verifies: ["RQ-0001#AC-2"] } },
  { id: "BG-0001", type: "Bug", links: { affects: ["RQ-0001"] } },
]);

describe("ArtifactGraph", () => {
  it("derives inbound edges from stored outbound ones", () => {
    // Nothing stores `implemented_by` or `affected_by`; both are read off the reverse index.
    expect(graph.incoming("RQ-0001", "implements").map((e) => e.from)).toEqual(["ST-0001"]);
    expect(graph.incoming("RQ-0001", "affects").map((e) => e.from)).toEqual(["BG-0001"]);
  });

  it("resolves criterion references to the base artifact", () => {
    expect(graph.incoming("RQ-0001", "verifies").map((e) => e.from)).toEqual(["TC-0001"]);
  });

  it("tolerates malformed links rather than throwing", () => {
    const messy = new ArtifactGraph([
      { id: "RQ-0002", type: "Requirement", links: { depends_on: "RQ-0001" as never } },
    ]);
    expect(messy.outgoing("RQ-0002")).toEqual([]);
  });
});

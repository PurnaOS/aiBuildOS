import { describe, expect, it } from "vitest";
import { resolveProfile } from "./profile.js";
import {
  criteriaRefusal,
  legalNextStates,
  legalTransition,
  transitionRefusal,
} from "./transitions.js";

/**
 * TC-0038 — verifying RQ-0010#AC-1 through #AC-4 (ST-0023).
 *
 * Built from literal type definitions rather than this repository's own `docs/profile/`, same reason
 * as `rules.test.ts`: a test tied to the live profile fails when the profile legitimately changes.
 */

const { profile } = resolveProfile([
  {
    file: "base.md",
    frontmatter: {
      defines: "Base",
      states: {
        vocabulary: ["draft", "active", "retired"],
        initial: "draft",
        transitions: [
          { from: "draft", to: "active" },
          { from: "*", to: "retired" },
        ],
      },
    },
  },
  // Declares no `states` of its own, so it inherits Base's whole-object — the `extends` merge item 1
  // asks to be pinned.
  { file: "child.md", frontmatter: { defines: "Child", extends: "Base" } },
  {
    file: "doc.md",
    frontmatter: {
      defines: "Doc",
      states: {
        vocabulary: ["draft", "ready", "building", "retired"],
        initial: "draft",
        transitions: [
          { from: "draft", to: "ready" },
          { from: "ready", to: "building" },
          { from: ["ready", "building"], to: "draft" },
          { from: "*", to: "retired" },
        ],
      },
    },
  },
]);

const base = profile.get("Base");
const child = profile.get("Child");
const doc = profile.get("Doc");
if (!base || !child || !doc) throw new Error("fixture profile did not resolve");

describe("legalNextStates", () => {
  it("answers exactly the declared pairs from several states, across types", () => {
    // Retirement's wildcard matches every state, so it rides along with every other target.
    expect(legalNextStates(doc, "draft")).toEqual(["ready", "retired"]);
    expect(legalNextStates(doc, "ready")).toEqual(["building", "draft", "retired"]);
    expect(legalNextStates(doc, "building")).toEqual(["draft", "retired"]);
    expect(legalNextStates(base, "draft")).toEqual(["active", "retired"]);
  });

  it("offers retirement from every declared state, including the initial one", () => {
    for (const state of ["draft", "ready", "building"]) {
      expect(legalNextStates(doc, state)).toContain("retired");
    }
  });

  it("offers only the wildcard's targets for a state outside the vocabulary (AC-3 + AC-5)", () => {
    expect(legalNextStates(doc, "nonsense")).toEqual(["retired"]);
  });

  it("inherits a parent's transitions through `extends` when a subtype declares none of its own", () => {
    expect(legalNextStates(child, "draft")).toEqual(legalNextStates(base, "draft"));
    expect(legalNextStates(child, "active")).toEqual(["retired"]);
  });
});

describe("legalTransition / transitionRefusal", () => {
  it("accepts a declared pair", () => {
    expect(legalTransition(doc, "draft", "ready")).toBe(true);
    expect(transitionRefusal(doc, "Doc", "draft", "ready")).toBeNull();
  });

  it("refuses an undeclared pair, naming it", () => {
    expect(legalTransition(doc, "draft", "building")).toBe(false);
    const refusal = transitionRefusal(doc, "Doc", "draft", "building");
    expect(refusal).toContain("draft");
    expect(refusal).toContain("building");
  });
});

describe("criteriaRefusal", () => {
  const before = "## Acceptance criteria\n\n- [AC-1] First.\n- [AC-3] Third.\n";

  it("allows editing a criterion's text without touching its number", () => {
    expect(
      criteriaRefusal(before, "## Acceptance criteria\n\n- [AC-1] Changed.\n- [AC-3] Third.\n"),
    ).toBeNull();
  });

  it("allows retiring a criterion outright", () => {
    expect(criteriaRefusal(before, "## Acceptance criteria\n\n- [AC-3] Third.\n")).toBeNull();
  });

  it("allows a fresh number above the old body's highest", () => {
    const after = "## Acceptance criteria\n\n- [AC-1] First.\n- [AC-3] Third.\n- [AC-4] Fourth.\n";
    expect(criteriaRefusal(before, after)).toBeNull();
  });

  it("refuses a number the old body never carried that is at or below the old maximum", () => {
    const after = "## Acceptance criteria\n\n- [AC-1] First.\n- [AC-2] Reused.\n- [AC-3] Third.\n";
    expect(criteriaRefusal(before, after)).toContain("AC-2");
  });

  it("refuses a number used twice in the new body", () => {
    const after =
      "## Acceptance criteria\n\n- [AC-1] First.\n- [AC-1] Duplicate.\n- [AC-3] Third.\n";
    expect(criteriaRefusal(before, after)).toContain("AC-1");
  });
});

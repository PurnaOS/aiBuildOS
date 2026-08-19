import { describe, expect, it } from "vitest";
import { type BodyParts, joinBody, splitBody } from "./ArtifactTab.js";

/**
 * TC-0025. An artifact's body survives being edited (RQ-0005#AC-7, AC-8).
 *
 * Two properties, and both are about not destroying what nobody touched. A criterion's **number** is
 * its identity — elsewhere in the bundle it is referred to as `RQ-0007#AC-2`, so renumbering after a
 * deletion silently repoints every one of those references at different text. And a criterion
 * written across two lines, which is most of them in this repository, must come back written across
 * two lines: unwrapping the section turns a one-field edit into a diff over the whole document.
 */
const BODY = `
# RQ-0007 — A thing

Some prose.

## Acceptance criteria

- [AC-1] The first thing.
- [AC-2] The second thing, which is long enough that it was written
  across two lines.
- [AC-3] The third thing.

## Notes

Kept.
`;

const edit = (parts: BodyParts, number: number, text: string): BodyParts => ({
  ...parts,
  criteria: parts.criteria.map((criterion) =>
    criterion.number === number ? { ...criterion, text } : criterion,
  ),
});

describe("an artifact's body", () => {
  it("splits into prose, criteria and whatever follows them", () => {
    const parts = splitBody(BODY);

    expect(parts.head).toBe("\n# RQ-0007 — A thing\n\nSome prose.\n\n");
    expect(parts.tail).toBe("\n## Notes\n\nKept.\n");
    expect(parts.criteria.map((criterion) => criterion.number)).toEqual([1, 2, 3]);
    expect(parts.criteria[1]?.text).toBe(
      "The second thing, which is long enough that it was written across two lines.",
    );
  });

  it("comes back byte-identical when nothing was edited", () => {
    // The case that matters most: changing only a frontmatter field must not touch the body at all.
    expect(joinBody(splitBody(BODY))).toBe(BODY);
  });

  it("keeps an untouched criterion wrapped exactly as it was written", () => {
    const parts = splitBody(BODY);
    const after = joinBody(edit(parts, 1, "The first thing, reworded."));

    expect(after).toContain("- [AC-1] The first thing, reworded.");
    // AC-2 was not edited, so its two lines are the two lines it arrived as.
    expect(after).toContain(
      "- [AC-2] The second thing, which is long enough that it was written\n  across two lines.",
    );
  });

  it("retires a deleted number rather than renumbering the rest", () => {
    const parts = splitBody(BODY);
    const after = joinBody({
      ...parts,
      criteria: parts.criteria.filter((criterion) => criterion.number !== 2),
    });

    expect(after).toContain("- [AC-1] The first thing.");
    // AC-3 stays AC-3. Were it renumbered to AC-2, `RQ-0007#AC-2` elsewhere would point here now.
    expect(after).toContain("- [AC-3] The third thing.");
    expect(after).not.toContain("[AC-2]");
  });

  it("appends a new criterion without disturbing the ones above it", () => {
    const parts = splitBody(BODY);
    const after = joinBody({
      ...parts,
      criteria: [
        ...parts.criteria,
        { number: 4, text: "The fourth thing.", original: "", source: "" },
      ],
    });

    expect(after).toBe(
      BODY.replace(
        "- [AC-3] The third thing.\n",
        "- [AC-3] The third thing.\n- [AC-4] The fourth thing.\n",
      ),
    );
  });

  it("writes a criterion added here even before anything is typed into it", () => {
    const parts = splitBody(BODY);
    const after = joinBody({
      ...parts,
      criteria: [...parts.criteria, { number: 4, text: "", original: "", source: "" }],
    });

    expect(after).toContain("- [AC-4]");
  });

  it("treats a body with no criteria section as prose, and leaves it alone", () => {
    const prose = "# Just prose\n\nAnd more of it.\n";
    const parts = splitBody(prose);

    expect(parts.hasCriteria).toBe(false);
    expect(parts.criteria).toEqual([]);
    expect(joinBody(parts)).toBe(prose);
  });
});

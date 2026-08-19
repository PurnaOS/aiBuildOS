import { describe, expect, it } from "vitest";
import { readCriteria, writeCriteria } from "./ArtifactTab.js";

/**
 * TC-0025. Acceptance criteria are read and written with their numbers intact (RQ-0005#AC-7).
 *
 * The number is the identity: elsewhere in the bundle a criterion is referred to as `RQ-0007#AC-2`,
 * so renumbering after a deletion silently repoints every one of those references at different text.
 */
const BODY = `
# RQ-0007 — A thing

Some prose.

## Acceptance criteria

- [AC-1] The first thing.
- [AC-2] The second thing, written
  across two lines.
- [AC-3] The third thing.

## Notes

Kept.
`;

describe("acceptance criteria", () => {
  it("reads each criterion, joining a wrapped one", () => {
    expect(readCriteria(BODY)).toEqual([
      { number: 1, text: "The first thing." },
      { number: 2, text: "The second thing, written across two lines." },
      { number: 3, text: "The third thing." },
    ]);
  });

  it("finds none when the section is absent", () => {
    expect(readCriteria("# Just prose\n")).toEqual([]);
  });

  it("retires a deleted number rather than renumbering the rest", () => {
    const kept = readCriteria(BODY).filter((criterion) => criterion.number !== 2);
    const after = writeCriteria(BODY, kept);

    expect(after).toContain("- [AC-1] The first thing.");
    expect(after).toContain("- [AC-3] The third thing.");
    // AC-3 stays AC-3. Were it renumbered to AC-2, `RQ-0007#AC-2` elsewhere would now point here.
    expect(after).not.toContain("[AC-2]");
  });

  it("leaves everything outside the section alone", () => {
    const after = writeCriteria(BODY, readCriteria(BODY));

    expect(after.startsWith("\n# RQ-0007 — A thing\n\nSome prose.\n")).toBe(true);
    expect(after).toContain("## Notes\n\nKept.\n");
  });

  it("returns the body untouched when there is no section to write into", () => {
    const body = "# Just prose\n";
    expect(writeCriteria(body, [{ number: 1, text: "x" }])).toBe(body);
  });
});

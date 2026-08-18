import { describe, expect, it } from "vitest";
import { type Bundle, type LoadedArtifact, validate } from "./validate.js";

function artifact(
  overrides: Partial<LoadedArtifact> & { frontmatter: Record<string, unknown> },
): LoadedArtifact {
  const id = String(overrides.frontmatter.id ?? "DC-0001");
  return {
    file: `docs/decisions/${id.toLowerCase()}.md`,
    dir: "docs/decisions",
    basename: `${id.toLowerCase()}.md`,
    keyLines: new Map([["id", 3]]),
    ...overrides,
  };
}

const valid = {
  type: "Decision",
  id: "DC-0001",
  title: "A decision",
  state: "accepted",
  owner: "srini",
  provenance: "agent",
  created: "2026-08-18",
};

function bundle(
  artifacts: LoadedArtifact[],
  index = "[DC-0001](dc-0001.md) [DC-0002](dc-0002.md)",
): Bundle {
  return { artifacts, indexes: new Map([["docs/decisions", index]]) };
}

describe("validate", () => {
  it("passes a well-formed artifact", () => {
    expect(validate(bundle([artifact({ frontmatter: valid })]))).toEqual([]);
  });

  it("reports a malformed ID", () => {
    const found = validate(bundle([artifact({ frontmatter: { ...valid, id: "DC-1" } })]));
    expect(found.map((f) => f.rule)).toContain("id/format");
  });

  it("reports a missing required field, with its line", () => {
    const { owner: _owner, ...missing } = valid;
    const found = validate(bundle([artifact({ frontmatter: missing })]));
    expect(found[0]?.rule).toBe("doc/field-required");
    expect(found[0]?.message).toContain("owner");
  });

  it("reports duplicate IDs", () => {
    const found = validate(
      bundle([artifact({ frontmatter: valid }), artifact({ frontmatter: valid })]),
    );
    expect(found.map((f) => f.rule)).toContain("id/duplicate");
  });

  it("reports a link whose target does not exist", () => {
    const found = validate(
      bundle([artifact({ frontmatter: { ...valid, links: { supersedes: ["DC-0099"] } } })]),
    );
    expect(found).toContainEqual(expect.objectContaining({ rule: "link/target-exists" }));
  });

  it("reports an artifact missing from its directory index", () => {
    const found = validate(bundle([artifact({ frontmatter: valid })], "# Decisions\n"));
    expect(found.map((f) => f.rule)).toContain("index/listed");
  });
});

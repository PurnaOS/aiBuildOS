import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { editArtifact, OkfEditError, updateIndexRow } from "./edit.js";

/**
 * TC-0024. Saving an artifact rewrites only what changed.
 *
 * This is the property [DC-0009](../../../docs/decisions/dc-0009.md) chose the CST for. `docs/` is
 * committed, so a writer that reformats frontmatter it never touched destroys the diff — and the
 * diff is how a person reviews what an agent did.
 */
const SOURCE = `---
type: Requirement
id: RQ-0007
title: "A thing the product must do"
state: draft
owner: srini
provenance: agent
created: 2026-08-19
generated: { by: "claude-code", at: 2026-08-19T00:00:00Z }
kind: functional
priority: p1
tags: [alpha, beta]
links:
  depends_on: [RQ-0001]
  related_to: [DC-0009]
---

# RQ-0007 — A thing the product must do

Some prose.

## Acceptance criteria

- [AC-1] It does the thing.
`;

describe("editing an artifact", () => {
  it("changes one field and leaves every other byte alone", () => {
    const after = editArtifact(SOURCE, { frontmatter: { state: "ready" } });

    expect(after).toBe(SOURCE.replace("state: draft", "state: ready"));
  });

  it("keeps a quoted title quoted, and an inline map inline", () => {
    const after = editArtifact(SOURCE, { frontmatter: { state: "ready" } });

    // The two most easily reformatted things in the file.
    expect(after).toContain('title: "A thing the product must do"');
    expect(after).toContain('generated: { by: "claude-code", at: 2026-08-19T00:00:00Z }');
  });

  it("sets a nested link list without touching its neighbour", () => {
    const after = editArtifact(SOURCE, {
      frontmatter: { "links.depends_on": ["RQ-0001", "RQ-0002"] },
    });

    expect(after).toContain("depends_on: [RQ-0001, RQ-0002]");
    expect(after).toContain("related_to: [DC-0009]");
    expect(after).toContain("tags: [alpha, beta]");
  });

  it("replaces the body and leaves the frontmatter byte-identical", () => {
    const after = editArtifact(SOURCE, { body: "\n# New\n" });

    const frontmatterOf = (text: string): string => text.split("---")[1] ?? "";
    expect(frontmatterOf(after)).toBe(frontmatterOf(SOURCE));
    expect(after.endsWith("\n# New\n")).toBe(true);
  });

  it("is a no-op when nothing is asked for", () => {
    expect(editArtifact(SOURCE, {})).toBe(SOURCE);
    expect(editArtifact(SOURCE, { frontmatter: {} })).toBe(SOURCE);
  });

  it("quotes a value that would otherwise change meaning", () => {
    const after = editArtifact(SOURCE, { frontmatter: { title: "yes: and no" } });

    // Unquoted, `yes: and no` would parse as a nested mapping rather than a title.
    expect(after).toMatch(/title: ['"]yes: and no['"]/);
  });

  it("refuses CRLF rather than silently normalising a whole file", () => {
    expect(() =>
      editArtifact(SOURCE.replace(/\n/g, "\r\n"), { frontmatter: { state: "ready" } }),
    ).toThrow(OkfEditError);
  });

  it("refuses a key that is not there, rather than inventing one", () => {
    expect(() => editArtifact(SOURCE, { frontmatter: { nonsense: "x" } })).toThrow(OkfEditError);
    expect(() => editArtifact(SOURCE, { frontmatter: { "links.nonsense": ["X-0001"] } })).toThrow(
      OkfEditError,
    );
  });

  it("creates a vouched-for key the file does not carry yet", () => {
    // Adding the first `verified_by` to a requirement that has never had one. Only the profile knows
    // that relationship is legal for this type, so the caller says so.
    const after = editArtifact(SOURCE, {
      frontmatter: { "links.verified_by": ["TC-0031"] },
      create: ["links.verified_by"],
    });

    expect(after).toContain("  related_to: [DC-0009]\n  verified_by: [TC-0031]");
    // Inserted, not rewritten: everything around it is byte-identical.
    expect(after.replace("\n  verified_by: [TC-0031]", "")).toBe(SOURCE);
  });

  it("creates the parent map too when the file has no `links` at all", () => {
    const bare = SOURCE.replace("links:\n  depends_on: [RQ-0001]\n  related_to: [DC-0009]\n", "");

    const after = editArtifact(bare, {
      frontmatter: { "links.implements": ["RQ-0001"] },
      create: ["links.implements"],
    });

    expect(after).toContain("links:\n  implements: [RQ-0001]");
  });

  it("still refuses a missing key nobody vouched for", () => {
    expect(() =>
      editArtifact(SOURCE, {
        frontmatter: { "links.nonsense": ["X-0001"] },
        create: ["links.other"],
      }),
    ).toThrow(OkfEditError);
  });

  it("keeps a block sequence a block sequence, at the indentation it already uses", () => {
    // Not this bundle's style, but an adopted project's may be — and converting between the two is a
    // formatting change to a region nobody asked about.
    const block = SOURCE.replace(
      "  depends_on: [RQ-0001]",
      "  depends_on:\n    - RQ-0001\n    - RQ-0004",
    );

    const after = editArtifact(block, {
      frontmatter: { "links.depends_on": ["RQ-0002", "RQ-0003"] },
    });

    expect(after).toContain("  depends_on:\n    - RQ-0002\n    - RQ-0003\n  related_to: [DC-0009]");
  });

  it("leaves a real artifact from this repository untouched but for the edit", () => {
    // A fixture cannot prove much on its own; this is a document the bundle actually contains,
    // comments, blank lines and all.
    const path = fileURLToPath(new URL("../../../docs/requirements/rq-0004.md", import.meta.url));
    const source = readFileSync(path, "utf8");

    const after = editArtifact(source, { frontmatter: { state: "built" } });

    expect(after).toBe(source.replace("state: ready", "state: built"));
  });
});

describe("keeping an index in step", () => {
  const INDEX = [
    "| ID | Title | State | Implements |",
    "| ---- | ------- | ------- | ------ |",
    "| [RQ-0001](rq-0001.md) | The first thing | built | [EP-0001](../epics/ep-0001.md) |",
    "| [RQ-0002](rq-0002.md) | The second thing | draft | [EP-0002](../epics/ep-0002.md) |",
  ].join("\n");

  it("sets the state of one row and leaves the rest alone", () => {
    const after = updateIndexRow(INDEX, "RQ-0002", { state: "ready" });

    expect(after).toBe(INDEX.replace("| draft |", "| ready |"));
  });

  it("keeps the row's other cells, including its links", () => {
    const after = updateIndexRow(INDEX, "RQ-0002", { title: "Renamed", state: "ready" });

    expect(after).toContain("| [RQ-0002](rq-0002.md) | Renamed | ready |");
    expect(after).toContain("[EP-0002](../epics/ep-0002.md) |");
  });

  it("leaves a row that merely links to the artifact alone", () => {
    // A requirement's row names what it depends on, with exactly the same link. Matching anywhere in
    // the line would rewrite that row's title and state with this artifact's.
    const withDependant = `${INDEX}\n| [RQ-0003](rq-0003.md) | The third thing | draft | [RQ-0002](rq-0002.md) |`;

    const after = updateIndexRow(withDependant, "RQ-0002", { title: "Renamed", state: "ready" });

    expect(after).toContain("| [RQ-0003](rq-0003.md) | The third thing | draft |");
  });

  it("does nothing when the artifact is not listed, or nothing is asked", () => {
    expect(updateIndexRow(INDEX, "RQ-0099", { state: "ready" })).toBe(INDEX);
    expect(updateIndexRow(INDEX, "RQ-0002", {})).toBe(INDEX);
  });
});

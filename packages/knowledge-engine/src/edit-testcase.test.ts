import { describe, expect, it } from "vitest";
import { editArtifact } from "./edit.js";
import { parseOkfDocument } from "./parse.js";
import { resolveProfile } from "./profile.js";
import { type Bundle, type LoadedArtifact, validate } from "./validate.js";

/**
 * TC-0062. The guarded save writing a TestCase's walk outcome — the first time `editArtifact` has
 * ever written this type, proven before ManualChecks.tsx exists to call it (RQ-0023#AC-2, AC-4).
 *
 * The profile fragment mirrors docs/profile/test-case.md's own shape rather than reading it: a test
 * that depends on the real profile is a test that fails when the profile legitimately changes
 * (rules.test.ts's own convention).
 */
const { profile } = resolveProfile([
  {
    file: "test-case.md",
    frontmatter: {
      defines: "TestCase",
      prefix: "TC",
      dir: "testing",
      fields: {
        kind: { kind: "enum", values: ["manual", "automated"], required: true },
        binding: { kind: "string" },
        last_result: { kind: "enum", values: ["passed", "failed"] },
        last_run: { kind: "string" },
        last_run_by: { kind: "string" },
      },
      states: { vocabulary: ["draft", "active", "retired"], initial: "draft" },
      links: { verifies: { target: ["Requirement"], min: 1 } },
      body: { sections: [{ name: "Steps", required: true }] },
    },
  },
]);

const MANUAL_TC = `---
type: TestCase
id: TC-0099
title: "A manual check nobody has walked yet"
state: draft
owner: srini
provenance: human
created: 2026-08-20
kind: manual
tags: [testing, manual]
---

# TC-0099 — A manual check nobody has walked yet

## Steps

1. Open the thing.
2. Confirm it looks right.
`;

/** The three fields, plus the value each takes when they are being set for the first time. */
const WALK = {
  last_result: "passed",
  last_run: "2026-08-20T12:00:00.000Z",
  last_run_by: "srini",
} as const;
const CREATE = ["last_result", "last_run", "last_run_by"];

function bundleOf(source: string): Bundle {
  const parsed = parseOkfDocument(source);
  const artifact: LoadedArtifact = {
    file: "docs/testing/tc-0099.md",
    dir: "docs/testing",
    basename: "tc-0099.md",
    body: parsed.body,
    keyLines: new Map(),
    frontmatter: parsed.frontmatter,
  };
  return {
    root: "docs",
    artifacts: [artifact],
    indexes: new Map([["docs/testing", "[TC-0099](tc-0099.md)"]]),
  };
}

describe("editArtifact writing a TestCase's walk outcome", () => {
  it("sets the three fields for the first time, leaving the body and every other key alone", () => {
    const after = editArtifact(MANUAL_TC, { frontmatter: WALK, create: CREATE });

    expect(after).toContain("last_result: passed");
    expect(after).toContain("last_run: 2026-08-20T12:00:00.000Z");
    expect(after).toContain("last_run_by: srini");

    // Inserted, not rewritten: everything around the three new lines is byte-identical (mirrors
    // edit.test.ts's own proof for a first `links.verified_by`).
    const withoutOutcome = after
      .replace("\nlast_result: passed", "")
      .replace("\nlast_run: 2026-08-20T12:00:00.000Z", "")
      .replace("\nlast_run_by: srini", "");
    expect(withoutOutcome).toBe(MANUAL_TC);

    expect(parseOkfDocument(after).body).toBe(parseOkfDocument(MANUAL_TC).body);
  });

  it("updates an already-walked TestCase's fields in place on a second walk", () => {
    const first = editArtifact(MANUAL_TC, {
      frontmatter: {
        last_result: "failed",
        last_run: "2026-08-20T09:00:00.000Z",
        last_run_by: "srini",
      },
      create: CREATE,
    });

    const second = editArtifact(first, {
      frontmatter: {
        last_result: "passed",
        last_run: "2026-08-20T12:00:00.000Z",
        last_run_by: "priya",
      },
      create: CREATE,
    });

    expect(second).toContain("last_result: passed");
    expect(second).not.toContain("last_result: failed");
    expect(second).toContain("last_run_by: priya");
    // No duplicate line from being inserted twice.
    expect(second.match(/^last_result:/gm)).toHaveLength(1);
  });

  it("is valid against the profile once walked", () => {
    const after = editArtifact(MANUAL_TC, { frontmatter: WALK, create: CREATE });

    expect(validate(bundleOf(after), profile)).toEqual([]);
  });

  it("validates clean without the fields — absent means never walked", () => {
    expect(validate(bundleOf(MANUAL_TC), profile)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { insertIndexRow, nextId, OkfCreateError, scaffoldArtifact } from "./create.js";
import { parseOkfDocument } from "./parse.js";
import { resolveProfile } from "./profile.js";
import { validate } from "./validate.js";

/**
 * TC-0029. A minted artifact is what its type says it is.
 *
 * The failure guarded against is a document that looks like an artifact and is not one. The strongest
 * case is the last: what is scaffolded is handed straight to the validator, which is the only
 * authority on the question.
 */
const PROFILE = resolveProfile([
  {
    file: "requirement.md",
    frontmatter: {
      type: "TypeDefinition",
      defines: "Requirement",
      prefix: "RQ",
      dir: "requirements",
      fields: {
        kind: { kind: "enum", values: ["functional", "nonfunctional"], required: true },
        priority: { kind: "enum", values: ["p1", "p2", "p3"], required: false },
      },
      states: { vocabulary: ["draft", "ready", "retired"], initial: "draft" },
      body: { sections: [{ name: "Acceptance criteria", required: true, items: "AC" }] },
    },
  },
  {
    file: "decision.md",
    frontmatter: {
      type: "TypeDefinition",
      defines: "Decision",
      prefix: "DC",
      dir: "decisions",
      states: { vocabulary: ["draft", "accepted"], initial: "draft" },
      body: { sections: [{ name: "Context" }, { name: "Decision" }] },
    },
  },
  {
    file: "work-item.md",
    frontmatter: {
      type: "TypeDefinition",
      defines: "WorkItem",
      abstract: true,
      states: { vocabulary: ["draft"], initial: "draft" },
    },
  },
]).profile;

const SCAFFOLD = {
  type: "Requirement",
  id: "RQ-0004",
  title: "A thing the product must do",
  owner: "srini",
  created: "2026-08-19",
};

describe("allocating an ID", () => {
  it("takes the number above the highest, whatever the gaps below it", () => {
    expect(nextId(["RQ-0001", "RQ-0007", "RQ-0003"], "RQ")).toBe("RQ-0008");
  });

  it("starts at one for a prefix nothing uses yet", () => {
    expect(nextId(["RQ-0001", "DC-0002"], "BG")).toBe("BG-0001");
  });

  it("widens past four digits without re-padding what came before", () => {
    expect(nextId(["RQ-9999"], "RQ")).toBe("RQ-10000");
  });

  it("ignores an ID of another prefix that happens to contain this one", () => {
    // `RQ` is a substring of nothing here by accident: the match is anchored, not searched.
    expect(nextId(["XRQ-0009", "RQ-0002"], "RQ")).toBe("RQ-0003");
  });
});

describe("scaffolding an artifact", () => {
  it("writes the common frontmatter, the type's required fields, and its sections", () => {
    const source = scaffoldArtifact(PROFILE, SCAFFOLD);

    expect(source).toContain("type: Requirement");
    expect(source).toContain("id: RQ-0004");
    expect(source).toContain('title: "A thing the product must do"');
    expect(source).toContain("state: draft");
    expect(source).toContain("owner: srini");
    expect(source).toContain("created: 2026-08-19");
    // Required by this type; `priority` is not, so it is not written.
    expect(source).toContain("kind: functional");
    expect(source).not.toContain("priority:");
    expect(source).toContain("## Acceptance criteria\n\n- [AC-1] ");
  });

  it("does not claim an agent wrote it", () => {
    const source = scaffoldArtifact(PROFILE, SCAFFOLD);

    // A person filled this in. `generated` is for an artifact an agent authored or revised, and
    // writing one here would put a false origin in the record.
    expect(source).toContain("provenance: human");
    expect(source).not.toContain("generated:");
  });

  it("invents no fields for a type that requires none", () => {
    const source = scaffoldArtifact(PROFILE, { ...SCAFFOLD, type: "Decision", id: "DC-0001" });

    expect(source).toContain("## Context");
    expect(source).toContain("## Decision");
    expect(source.split("---")[1]?.trim().split("\n")).toHaveLength(7);
  });

  it("passes the validator that will judge it", () => {
    const source = scaffoldArtifact(PROFILE, SCAFFOLD);
    const parsed = parseOkfDocument(source);

    const findings = validate(
      {
        root: "",
        artifacts: [
          {
            file: "requirements/rq-0004.md",
            dir: "requirements",
            basename: "rq-0004.md",
            frontmatter: parsed.frontmatter,
            body: parsed.body,
            keyLines: parsed.keyLines,
          },
        ],
        indexes: new Map([
          ["requirements", "| ID |\n| -- |\n| [RQ-0004](rq-0004.md) | x | draft |"],
        ]),
      },
      PROFILE,
    );

    expect(findings.filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("refuses a type the profile does not describe, or will not allow directly", () => {
    expect(() => scaffoldArtifact(PROFILE, { ...SCAFFOLD, type: "Nonsense" })).toThrow(
      OkfCreateError,
    );
    expect(() => scaffoldArtifact(PROFILE, { ...SCAFFOLD, type: "WorkItem" })).toThrow(
      OkfCreateError,
    );
  });

  it("refuses to write an artifact with no owner", () => {
    expect(() => scaffoldArtifact(PROFILE, { ...SCAFFOLD, owner: "  " })).toThrow(OkfCreateError);
  });
});

describe("adding an index row", () => {
  const INDEX = [
    "# Requirements",
    "",
    "| ID | Title | State | Implements |",
    "| ---- | ------- | ------- | ------ |",
    "| [RQ-0001](rq-0001.md) | The first thing | draft | — |",
    "",
    "_A note under the table._",
  ].join("\n");

  it("appends under the last row, leaving the header and every row alone", () => {
    const row = "| [RQ-0002](rq-0002.md) | The second thing | draft | — |";

    expect(insertIndexRow(INDEX, row)).toBe(
      INDEX.replace(
        "| [RQ-0001](rq-0001.md) | The first thing | draft | — |",
        `| [RQ-0001](rq-0001.md) | The first thing | draft | — |\n${row}`,
      ),
    );
  });

  it("writes the first row of an empty table", () => {
    const empty = INDEX.split("\n")
      .filter((line) => !line.startsWith("| ["))
      .join("\n");
    const row = "| [RQ-0001](rq-0001.md) | The first thing | draft | — |";

    expect(insertIndexRow(empty, row)).toContain(
      "| ---- | ------- | ------- | ------ |\n| [RQ-0001](rq-0001.md)",
    );
  });

  it("refuses an index with no table rather than guessing where a row goes", () => {
    expect(() => insertIndexRow("# Requirements\n\nJust prose.\n", "| x |")).toThrow(
      OkfCreateError,
    );
  });
});

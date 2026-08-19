import { describe, expect, it } from "vitest";
import { resolveProfile } from "./profile.js";
import { type Bundle, type Finding, type LoadedArtifact, validate } from "./validate.js";

/**
 * TC-0011 (`-t frontmatter`), TC-0012 (`-t 'link rules'`) and TC-0013 (`-t body`) — verifying
 * RQ-0003#AC-2 through #AC-13 (ST-0007, ST-0008).
 *
 * The profile here is built from literals rather than read from this repository's own
 * `docs/profile/`: a rule test that depends on the real profile is a test that fails when the
 * profile legitimately changes.
 */

const { profile } = resolveProfile([
  { file: "base.md", frontmatter: { defines: "Base", abstract: true } },
  {
    file: "group.md",
    frontmatter: { defines: "Group", prefix: "EP", dir: "groups" },
  },
  {
    file: "item.md",
    frontmatter: {
      defines: "Item",
      extends: "Base",
      prefix: "RQ",
      dir: "items",
      fields: {
        kind: { kind: "enum", values: ["functional", "nonfunctional"], required: true },
        priority: { kind: "enum", values: ["p1", "p2", "p3"] },
      },
      states: { vocabulary: ["draft", "ready", "done"], initial: "draft" },
      links: {
        implements: { target: ["Item"], min: 1 },
        parent: { target: ["Group"], max: 1 },
        depends_on: { target: ["Base"], cycles: "forbid" },
        constrains: { target: ["Item", "Architecture"] },
      },
      body: {
        sections: [{ name: "Acceptance criteria", required: true, items: "AC" }, { name: "Notes" }],
      },
    },
  },
  { file: "sub.md", frontmatter: { defines: "Sub", extends: "Item", prefix: "ST", dir: "subs" } },
]);

const DIRS: Record<string, string> = { Item: "items", Group: "groups", Sub: "subs" };
const BODY = "\n## Acceptance criteria\n\n- [AC-1] It works.\n";

/** A well-formed artifact of `type`. Anything the tests do not override satisfies every rule. */
function artifact(
  type: string,
  id: string,
  frontmatter: Record<string, unknown> = {},
  body = BODY,
): LoadedArtifact {
  const dir = `docs/${DIRS[type] ?? "elsewhere"}`;
  const basename = `${id.toLowerCase()}.md`;
  return {
    file: `${dir}/${basename}`,
    dir,
    basename,
    body,
    keyLines: new Map([
      ["type", 2],
      ["id", 3],
      ["state", 5],
      ["provenance", 7],
      ["links", 10],
    ]),
    frontmatter: {
      type,
      id,
      title: "A thing",
      state: "ready",
      owner: "srini",
      provenance: "human",
      created: "2026-08-19",
      ...(type === "Item" || type === "Sub" ? { kind: "functional" } : {}),
      ...(type === "Item" || type === "Sub" ? { links: { implements: [id] } } : {}),
      ...frontmatter,
    },
  };
}

function check(...artifacts: LoadedArtifact[]): Finding[] {
  const indexes = new Map<string, string>();
  for (const a of artifacts) {
    indexes.set(a.dir, `${indexes.get(a.dir) ?? ""} [x](${a.basename})`);
  }
  const bundle: Bundle = { root: "docs", artifacts, indexes };
  return validate(bundle, profile);
}

const rules = (findings: Finding[]): string[] => findings.map((f) => f.rule);

describe("frontmatter rules", () => {
  it("passes an artifact that satisfies its type completely", () => {
    expect(check(artifact("Item", "RQ-0001"))).toEqual([]);
  });

  it("warns, never errors, on a type the profile does not define", () => {
    const found = check(artifact("Architecture", "AR-0001", {}, ""));
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toBe("type/unknown");
    expect(found[0]?.severity).toBe("warn");
    expect(found[0]?.line).toBe(2);
  });

  it("still applies the common rules to an unprofiled type", () => {
    const found = check(artifact("Architecture", "AR-1", {}, ""));
    expect(rules(found)).toContain("id/format");
  });

  it("errors on an abstract type used directly", () => {
    expect(rules(check(artifact("Base", "RQ-0001", { links: {} })))).toContain("type/abstract");
  });

  it("errors on an ID prefix that is not the type's", () => {
    const found = check(artifact("Item", "DC-0001"));
    expect(rules(found)).toContain("type/prefix");
    expect(found.find((f) => f.rule === "type/prefix")?.message).toContain("RQ");
  });

  it("errors on an artifact outside its type's directory", () => {
    const stray = { ...artifact("Item", "RQ-0001"), dir: "docs/groups" };
    expect(rules(check(stray))).toContain("type/dir");
  });

  it("errors on a missing required field", () => {
    const found = check(artifact("Item", "RQ-0001", { kind: undefined }));
    expect(rules(found)).toContain("field/required");
    expect(found.find((f) => f.rule === "field/required")?.message).toContain("kind");
  });

  it("errors on a value outside an enum, naming what was allowed", () => {
    const found = check(artifact("Item", "RQ-0001", { priority: "p9" }));
    expect(found.find((f) => f.rule === "field/enum")?.message).toContain("p1, p2, p3");
  });

  it("errors on a state outside the vocabulary, with its line", () => {
    const found = check(artifact("Item", "RQ-0001", { state: "banana" }));
    expect(found.find((f) => f.rule === "state/unknown")?.line).toBe(5);
  });

  it("checks state membership only, not reachability by transition", () => {
    // `done` is in the vocabulary but no transition here says how to get there from `ready`.
    expect(check(artifact("Item", "RQ-0001", { state: "done" }))).toEqual([]);
  });

  it("errors when an agent-authored artifact has no `generated`", () => {
    const found = check(artifact("Item", "RQ-0001", { provenance: "agent" }));
    expect(rules(found)).toContain("doc/generated-required");
    expect(check(artifact("Item", "RQ-0001", { provenance: "human" }))).toEqual([]);
  });
});

describe("link rules", () => {
  const item = (id: string, links: Record<string, string[]>, state = "ready") =>
    artifact("Item", id, { links, state });

  it("warns on a relationship the type does not declare", () => {
    const found = check(item("RQ-0001", { implements: ["RQ-0001"], affects: ["RQ-0001"] }));
    expect(found).toHaveLength(1);
    expect(found[0]?.rule).toBe("link/unknown-relationship");
    expect(found[0]?.severity).toBe("warn");
  });

  it("errors when a target's type is not accepted, naming the type it got", () => {
    const found = check(
      item("RQ-0001", { implements: ["RQ-0001"], parent: ["RQ-0002"] }),
      item("RQ-0002", { implements: ["RQ-0002"] }),
    );
    expect(found.find((f) => f.rule === "link/target-type")?.message).toContain("is a Item");
  });

  it("accepts a subtype of the declared target", () => {
    // `depends_on` targets the abstract `Base`; `Sub` extends `Item` extends `Base`.
    const found = check(
      item("RQ-0001", { implements: ["RQ-0001"], depends_on: ["ST-0001"] }),
      artifact("Sub", "ST-0001", { links: { implements: ["ST-0001"] } }),
    );
    expect(found).toEqual([]);
  });

  it("accepts a target type the profile does not define", () => {
    const found = check(
      item("RQ-0001", { implements: ["RQ-0001"], constrains: ["AR-0001"] }),
      artifact("Architecture", "AR-0001", {}, ""),
    );
    expect(rules(found)).toEqual(["type/unknown"]);
  });

  it("reports a missing target once, not twice", () => {
    const found = check(item("RQ-0001", { implements: ["RQ-0099"] }));
    expect(rules(found)).toEqual(["link/target-exists"]);
  });

  it("enforces min past the initial state and exempts a draft", () => {
    expect(rules(check(item("RQ-0001", {})))).toContain("link/cardinality");
    expect(check(item("RQ-0001", {}, "draft"))).toEqual([]);
  });

  it("enforces max in every state", () => {
    const two = { implements: ["RQ-0001"], parent: ["EP-0001", "EP-0002"] };
    const groups = [artifact("Group", "EP-0001"), artifact("Group", "EP-0002")];
    expect(rules(check(item("RQ-0001", two), ...groups))).toContain("link/cardinality");
    expect(rules(check(item("RQ-0001", two, "draft"), ...groups))).toContain("link/cardinality");
  });

  it("reports a cycle once, naming the path around it", () => {
    const found = check(
      item("RQ-0001", { implements: ["RQ-0001"], depends_on: ["RQ-0002"] }),
      item("RQ-0002", { implements: ["RQ-0002"], depends_on: ["RQ-0003"] }),
      item("RQ-0003", { implements: ["RQ-0003"], depends_on: ["RQ-0001"] }),
    );
    const cycles = found.filter((f) => f.rule === "link/cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.message).toContain("RQ-0001 -> RQ-0002 -> RQ-0003 -> RQ-0001");
  });

  it("does not report an acyclic chain or a diamond", () => {
    const chain = check(
      item("RQ-0001", { implements: ["RQ-0001"], depends_on: ["RQ-0002"] }),
      item("RQ-0002", { implements: ["RQ-0002"], depends_on: ["RQ-0003"] }),
      item("RQ-0003", { implements: ["RQ-0003"] }),
    );
    expect(chain).toEqual([]);

    const diamond = check(
      item("RQ-0001", { implements: ["RQ-0001"], depends_on: ["RQ-0002", "RQ-0003"] }),
      item("RQ-0002", { implements: ["RQ-0002"], depends_on: ["RQ-0004"] }),
      item("RQ-0003", { implements: ["RQ-0003"], depends_on: ["RQ-0004"] }),
      item("RQ-0004", { implements: ["RQ-0004"] }),
    );
    expect(diamond).toEqual([]);
  });
});

describe("body rules", () => {
  it("errors on a missing required section", () => {
    const found = check(artifact("Item", "RQ-0001", {}, "\n# RQ-0001\n"));
    expect(found.find((f) => f.rule === "body/section-missing")?.message).toContain(
      "Acceptance criteria",
    );
  });

  it("does not count a deeper heading as the section", () => {
    const body = "\n### Acceptance criteria\n\n- [AC-1] It works.\n";
    expect(rules(check(artifact("Item", "RQ-0001", {}, body)))).toContain("body/section-missing");
  });

  it("errors on a criteria section with no [AC-n] items", () => {
    const body = "\n## Acceptance criteria\n\nTo be written.\n";
    expect(rules(check(artifact("Item", "RQ-0001", {}, body)))).toContain("body/criteria");
  });

  it("errors on a criterion number used twice", () => {
    const body = "\n## Acceptance criteria\n\n- [AC-1] One.\n- [AC-1] Also one.\n";
    const found = check(artifact("Item", "RQ-0001", {}, body));
    expect(found.find((f) => f.rule === "body/criteria")?.message).toContain("[AC-1]");
  });

  it("accepts non-contiguous numbers — criteria are append-only, not dense", () => {
    const body = "\n## Acceptance criteria\n\n- [AC-1] One.\n- [AC-3] Three.\n- [AC-4] Four.\n";
    expect(check(artifact("Item", "RQ-0001", {}, body))).toEqual([]);
  });

  it("accepts a link to a criterion that exists", () => {
    const found = check(
      artifact("Item", "RQ-0001", { links: { implements: ["RQ-0002#AC-1"] } }),
      artifact("Item", "RQ-0002"),
    );
    expect(found).toEqual([]);
  });

  it("errors on a link to a criterion the target does not declare", () => {
    const found = check(
      artifact("Item", "RQ-0001", { links: { implements: ["RQ-0002#AC-9"] } }),
      artifact("Item", "RQ-0002"),
    );
    expect(found.find((f) => f.rule === "link/criterion-exists")?.message).toContain("AC-9");
  });

  it("reports a criterion link to a missing artifact only as a missing target", () => {
    const found = check(artifact("Item", "RQ-0001", { links: { implements: ["RQ-0099#AC-1"] } }));
    expect(rules(found)).toEqual(["link/target-exists"]);
  });

  it("says nothing about the body of a type that declares no sections", () => {
    expect(check(artifact("Group", "EP-0001", {}, "\n# EP-0001\n"))).toEqual([]);
  });
});

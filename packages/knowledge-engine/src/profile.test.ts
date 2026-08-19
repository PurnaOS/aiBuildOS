import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadBundle, loadProfile } from "./load.js";
import { resolveProfile } from "./profile.js";
import { validate } from "./validate.js";

/** TC-0010 — verifies RQ-0003#AC-1 and #AC-14 (ST-0006). */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function doc(frontmatter: string, body = ""): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

/** A bundle on disk. `files` maps a bundle-relative path to its whole text. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "okf-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text, "utf8");
  }
  return root;
}

describe("loadProfile", () => {
  it("collects type definitions and skips the index and the manifest", () => {
    const root = fixture({
      "profile/README.md": "# Type profile\n",
      "profile/profile.md": doc("name: test\nversion: 0.1.0\nformats: 1"),
      "profile/thing.md": doc("type: TypeDefinition\ndefines: Thing\nprefix: BG\ndir: things"),
      "profile/notes.md": "Just prose, no frontmatter.\n",
    });

    const { profile, issues } = loadProfile(root);

    expect(issues).toEqual([]);
    expect(profile.names()).toEqual(["Thing"]);
    expect(profile.get("Thing")?.prefix).toBe("BG");
  });

  it("reports a type definition that will not parse, and resolves the rest", () => {
    const root = fixture({
      "profile/broken.md": doc("type: TypeDefinition\ndefines: [not, a, string]"),
      "profile/good.md": doc("type: TypeDefinition\ndefines: Good"),
    });

    const { profile, issues } = loadProfile(root);

    expect(issues).toHaveLength(1);
    expect(issues[0]?.file).toContain("broken.md");
    expect(profile.get("Good")).toBeDefined();
  });

  it("treats a bundle with no profile directory as an empty profile, not an error", () => {
    const { profile, issues } = loadProfile(fixture({ "README.md": "# Bundle\n" }));

    expect(issues).toEqual([]);
    expect(profile.names()).toEqual([]);
  });
});

describe("resolveProfile", () => {
  const chain = [
    {
      file: "base.md",
      frontmatter: {
        defines: "Base",
        abstract: true,
        fields: { priority: { kind: "enum", values: ["p1", "p2"] } },
        links: { related_to: { target: ["Base"] } },
      },
    },
    {
      file: "middle.md",
      frontmatter: {
        defines: "Middle",
        extends: "Base",
        abstract: true,
        fields: { estimate: { kind: "number" } },
        links: { depends_on: { target: ["Base"], cycles: "forbid" } },
      },
    },
    {
      file: "leaf.md",
      frontmatter: {
        defines: "Leaf",
        extends: "Middle",
        prefix: "LF",
        dir: "leaves",
        fields: { priority: { kind: "enum", values: ["p3"], required: true } },
        states: { vocabulary: ["draft", "done"], initial: "draft" },
      },
    },
  ];

  it("merges fields, links and states along the whole chain, child winning", () => {
    const { profile, issues } = resolveProfile(chain);
    const leaf = profile.get("Leaf");

    expect(issues).toEqual([]);
    // Redefined by the child two levels down.
    expect(leaf?.fields.priority).toEqual({ kind: "enum", values: ["p3"], required: true });
    // Inherited from the grandparent and from the parent respectively.
    expect(leaf?.fields.estimate).toEqual({ kind: "number" });
    expect(leaf?.links.related_to).toEqual({ target: ["Base"] });
    expect(leaf?.links.depends_on?.cycles).toBe("forbid");
    expect(leaf?.states?.initial).toBe("draft");
  });

  it("does not inherit abstractness", () => {
    const { profile } = resolveProfile(chain);
    expect(profile.get("Middle")?.abstract).toBe(true);
    expect(profile.get("Leaf")?.abstract).toBe(false);
  });

  it("answers supertype questions along the chain", () => {
    const { profile } = resolveProfile(chain);
    expect(profile.isA("Leaf", "Base")).toBe(true);
    expect(profile.isA("Leaf", "Leaf")).toBe(true);
    expect(profile.isA("Base", "Leaf")).toBe(false);
  });

  it("matches a type the profile does not define by name rather than failing", () => {
    const { profile } = resolveProfile(chain);
    // `Architecture` is ID-reserved and deliberately unprofiled, yet Decision really does declare
    // `constrains: { target: [..., Architecture] }`.
    expect(profile.isA("Architecture", "Architecture")).toBe(true);
    expect(profile.isA("Architecture", "Base")).toBe(false);
  });

  it("reports an unresolvable or cyclic extends chain without hanging", () => {
    const orphan = resolveProfile([
      { file: "a.md", frontmatter: { defines: "A", extends: "Gone" } },
    ]);
    expect(orphan.issues[0]?.message).toContain("Gone");

    const loop = resolveProfile([
      { file: "a.md", frontmatter: { defines: "A", extends: "B" } },
      { file: "b.md", frontmatter: { defines: "B", extends: "A" } },
    ]);
    expect(loop.issues.some((issue) => issue.message.includes("cyclic"))).toBe(true);
  });
});

describe("docs:check", () => {
  const artifact = doc(
    [
      "type: Thing",
      "id: BG-0001",
      'title: "A thing"',
      "state: draft",
      "owner: srini",
      "provenance: human",
      "created: 2026-08-19",
    ].join("\n"),
    "\n# BG-0001\n",
  );

  it("keeps its output shape and exits zero on a clean bundle", () => {
    const root = fixture({
      "profile/thing.md": doc(
        "type: TypeDefinition\ndefines: Thing\nprefix: BG\ndir: things\nstates:\n  vocabulary: [draft]\n  initial: draft",
      ),
      "things/README.md": "| [BG-0001](bg-0001.md) |\n",
      "things/bg-0001.md": artifact,
    });

    const run = spawnSync("bun", ["tools/okf/cli.ts", root], { encoding: "utf8" });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain("1 artifacts, 1 indexes — 0 errors");
  });

  it("exits non-zero when a profile rule fails", () => {
    const root = fixture({
      "profile/thing.md": doc(
        "type: TypeDefinition\ndefines: Thing\nprefix: BG\ndir: things\nstates:\n  vocabulary: [draft]\n  initial: draft",
      ),
      "things/README.md": "| [BG-0001](bg-0001.md) |\n",
      "things/bg-0001.md": artifact.replace("state: draft", "state: banana"),
    });

    const run = spawnSync("bun", ["tools/okf/cli.ts", root], { encoding: "utf8" });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("state/unknown");
  });

  it("validates against the common rules alone when there is no profile", () => {
    const root = fixture({
      "things/README.md": "| [BG-0001](bg-0001.md) |\n",
      "things/bg-0001.md": artifact,
    });

    const { bundle } = loadBundle(root);
    const { profile } = loadProfile(root);

    expect(validate(bundle, profile)).toEqual([]);
    expect(validate(bundle)).toEqual([]);
  });
});

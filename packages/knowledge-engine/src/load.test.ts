import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBundle, summarize } from "./load.js";

/**
 * TC-0009. The walker that both the `docs:check` CLI and the desktop app read a bundle with.
 *
 * Permissive consumption is the behaviour under test (okf-conventions §1): anything that is not an
 * artifact is skipped rather than thrown on, and a file that will not parse is *reported* rather than
 * dropped.
 */
describe("loadBundle", () => {
  let base: string;
  let root: string;

  const artifact = (id: string, type: string, state: string): string =>
    [
      "---",
      `type: ${type}`,
      `id: ${id}`,
      `title: "${id}"`,
      `state: ${state}`,
      "owner: srini",
      "provenance: agent",
      "created: 2026-08-18",
      "---",
      "",
      `# ${id}`,
      "",
    ].join("\n");

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "aibuildos-bundle-"));
    root = join(base, "docs");

    mkdirSync(join(root, "requirements"), { recursive: true });
    mkdirSync(join(root, "profile"), { recursive: true });

    writeFileSync(join(root, "README.md"), "# Bundle\n", "utf8");
    writeFileSync(join(root, "requirements", "README.md"), "# Requirements\n", "utf8");
    writeFileSync(
      join(root, "requirements", "rq-0001.md"),
      artifact("RQ-0001", "Requirement", "ready"),
      "utf8",
    );
    writeFileSync(
      join(root, "requirements", "rq-0002.md"),
      artifact("RQ-0002", "Requirement", "draft"),
      "utf8",
    );
    // Prose. Allowed here, and not an artifact.
    writeFileSync(join(root, "requirements", "notes.md"), "Just some notes.\n", "utf8");
    // A type definition, not an artifact — `profile/` is skipped wholesale.
    writeFileSync(
      join(root, "profile", "requirement.md"),
      "---\ntype: TypeDefinition\ndefines: Requirement\n---\n",
      "utf8",
    );
    // Not Markdown at all.
    writeFileSync(join(root, "requirements", "data.json"), "{}\n", "utf8");
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("collects every artifact with its directory and basename", () => {
    const { bundle } = loadBundle(root, base);

    expect(bundle.artifacts.map((a) => a.basename).sort()).toEqual(["rq-0001.md", "rq-0002.md"]);
    expect(bundle.artifacts[0]?.dir).toBe("docs/requirements");
    expect(bundle.artifacts[0]?.frontmatter.id).toBe("RQ-0001");
  });

  it("skips profile/, prose without frontmatter, and non-Markdown files", () => {
    const { bundle, parseErrors } = loadBundle(root, base);

    const files = bundle.artifacts.map((a) => a.basename);
    expect(files).not.toContain("requirement.md");
    expect(files).not.toContain("notes.md");
    expect(files).not.toContain("data.json");
    expect(parseErrors).toEqual([]);
  });

  it("collects each README.md as an index rather than as an artifact", () => {
    const { bundle } = loadBundle(root, base);

    expect([...bundle.indexes.keys()].sort()).toEqual(["docs", "docs/requirements"]);
    expect(bundle.indexes.get("docs")).toContain("# Bundle");
  });

  it("reports paths relative to the base it was given", () => {
    const { bundle } = loadBundle(root, base);
    expect(bundle.artifacts.map((a) => a.file).sort()).toEqual([
      "docs/requirements/rq-0001.md",
      "docs/requirements/rq-0002.md",
    ]);

    // Same walk, different base: the CLI reports repo-relative paths, the app project-relative ones.
    const { bundle: fromRoot } = loadBundle(root);
    expect(fromRoot.artifacts.map((a) => a.file).sort()).toEqual([
      "requirements/rq-0001.md",
      "requirements/rq-0002.md",
    ]);
  });

  it("reports an unparseable artifact and still lists it, so a validator can complain", () => {
    writeFileSync(join(root, "requirements", "rq-0003.md"), "---\nnot: [closed\n", "utf8");

    const { bundle, parseErrors } = loadBundle(root, base);

    expect(parseErrors).toHaveLength(1);
    expect(parseErrors[0]?.file).toBe("docs/requirements/rq-0003.md");
    expect(bundle.artifacts.map((a) => a.basename)).toContain("rq-0003.md");
  });

  it("summarises by type and by state", () => {
    const { bundle } = loadBundle(root, base);
    const summary = summarize(bundle);

    expect(summary.artifacts).toBe(2);
    expect(summary.indexes).toBe(2);
    expect(summary.byType).toEqual({ Requirement: 2 });
    expect(summary.byState).toEqual({ ready: 1, draft: 1 });
  });

  it("summarises an empty bundle as zero rather than failing", () => {
    const empty = join(base, "empty");
    mkdirSync(empty);

    const { bundle } = loadBundle(empty);

    expect(summarize(bundle)).toMatchObject({ artifacts: 0, byType: {}, byState: {} });
  });
});

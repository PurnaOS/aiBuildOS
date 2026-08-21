import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedPlaybooks } from "./playbooks.js";
import { bundleFiles } from "./scaffold.js";

/**
 * Seeding the standard playbooks into a project the scaffold did not create (RQ-0013#AC-4, DC-0019).
 *
 * The fixture is an "adopted" project: the same template `bundleFiles()` writes for a fresh scaffold,
 * minus whichever playbook pieces a test wants missing, git-initialised with a local identity — the
 * shape a real pre-DC-0019 repository is in.
 */
describe("seeding playbooks into an adopted project", () => {
  let dir: string;

  // A repository with no identity means no identity in *any* scope — `git config user.name` reads
  // the global and system files too, and the machine running this suite may well have one.
  const NO_GLOBAL = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aibuildos-playbooks-"));
    execFileSync("git", ["-C", dir, "init", "--quiet"]);
    Object.assign(process.env, NO_GLOBAL);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(NO_GLOBAL)) delete process.env[key];
  });

  /** Writes the template bundle, dropping playbook pieces — and, opted out, the root instruction
   * files RQ-0028 seeds or the `.claude/` guardrail layer RQ-0049 seeds — the caller does not
   * want present. */
  function adopt(
    options: {
      playbooks?: boolean;
      profileType?: boolean;
      instructions?: boolean;
      hooks?: boolean;
    } = {},
  ): void {
    for (const [relative, content] of bundleFiles()) {
      if (options.playbooks === false && relative.startsWith("docs/playbooks/")) continue;
      if (options.profileType === false && relative === "docs/profile/playbook.md") continue;
      if (options.hooks === false && relative.startsWith(".claude/")) continue;
      if (
        options.instructions === false &&
        (relative === "AGENTS.md" || relative === "CLAUDE.md")
      ) {
        continue;
      }
      const target = join(dir, relative);
      mkdirSync(dirname(target), { recursive: true });
      // Nothing here calls `seedPlaybooks` yet, so the `{{OWNER}}` token is never resolved by
      // adoption itself — only by the function under test.
      writeFileSync(target, content, "utf8");
    }
  }

  it("refuses without a configured identity — writing no artifacts, but still the hooks", () => {
    adopt({ playbooks: false, profileType: false, hooks: false });

    const problem = seedPlaybooks(dir, true);

    expect(problem).toContain("user.name");
    expect(existsSync(join(dir, "docs", "playbooks"))).toBe(false);
    // The guardrail layer needs no owner, so the refusal does not hold it back (RQ-0049#AC-1).
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(dir, ".claude", "hooks", "guard-record.sh"))).toBe(true);
  });

  it("writes the standard playbooks, healing a profile that predates the type", () => {
    adopt({ playbooks: false, profileType: false });
    execFileSync("git", ["-C", dir, "config", "user.name", "Adopter"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "adopter@example.com"]);

    const problem = seedPlaybooks(dir);

    expect(problem).toBeNull();
    // The type this project's profile never declared, so the artifacts it just gained resolve.
    expect(existsSync(join(dir, "docs", "profile", "playbook.md"))).toBe(true);
    for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
      const text = readFileSync(join(dir, "docs", "playbooks", `${id}.md`), "utf8");
      expect(text).toContain("owner: Adopter\n");
      expect(text).not.toContain("{{OWNER}}");
    }
  });

  /**
   * TC-0079 (RQ-0028#AC-3). Seeding an adopted project also seeds the root instruction files it was
   * scaffolded without, and never overwrites one that is already there.
   */
  it("writes AGENTS.md and CLAUDE.md when the project has neither", () => {
    adopt({ playbooks: false, profileType: false, instructions: false });
    execFileSync("git", ["-C", dir, "config", "user.name", "Adopter"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "adopter@example.com"]);

    expect(seedPlaybooks(dir)).toBeNull();

    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(agents).toContain("Never edit a `state:` field");
    expect(claude).toContain("@AGENTS.md");
    // Neither carries frontmatter, so unlike the playbooks the owner token never applies.
    expect(agents).not.toContain("{{OWNER}}");
  });

  it("never overwrites an existing CLAUDE.md, even while it seeds everything else", () => {
    adopt({ playbooks: false, profileType: false, instructions: false });
    writeFileSync(join(dir, "CLAUDE.md"), "# This project's own CLAUDE.md\n", "utf8");
    execFileSync("git", ["-C", dir, "config", "user.name", "Adopter"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "adopter@example.com"]);

    expect(seedPlaybooks(dir)).toBeNull();

    // The project's own file, untouched — not the template's.
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8")).toBe("# This project's own CLAUDE.md\n");
    // AGENTS.md was genuinely absent, so it is still written.
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
  });

  it("seeding a second time overwrites nothing, instructions included", () => {
    adopt({ playbooks: false, profileType: false, instructions: false });
    execFileSync("git", ["-C", dir, "config", "user.name", "Adopter"]);
    execFileSync("git", ["-C", dir, "config", "user.email", "adopter@example.com"]);
    expect(seedPlaybooks(dir)).toBeNull();
    const agentsAfterFirstSeed = readFileSync(join(dir, "AGENTS.md"), "utf8");

    const problem = seedPlaybooks(dir);

    expect(problem).toContain("already has playbook");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(agentsAfterFirstSeed);
  });

  it("leaves an already-declared profile type alone", () => {
    adopt({ playbooks: false, profileType: true });
    execFileSync("git", ["-C", dir, "config", "user.name", "Adopter"]);

    const before = readFileSync(join(dir, "docs", "profile", "playbook.md"), "utf8");
    expect(seedPlaybooks(dir)).toBeNull();

    expect(readFileSync(join(dir, "docs", "profile", "playbook.md"), "utf8")).toBe(before);
  });

  /**
   * TC-0117 (RQ-0049#AC-1). A project scaffolded before the guardrail layer existed gains it on
   * re-seed — even though the playbook refusal still stands — and a hook file that is already
   * there, edited or not, is never overwritten.
   */
  it("adds missing hook files on re-seed, playbook refusal and all", () => {
    adopt({ playbooks: true, profileType: true, hooks: false });
    execFileSync("git", ["-C", dir, "config", "user.name", "Adopter"]);

    const problem = seedPlaybooks(dir, true);

    // The refusal is unchanged; the guardrails landed anyway.
    expect(problem).toContain("already has playbook");
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(dir, ".claude", "hooks", "guard-record.sh"))).toBe(true);
  });

  it("never overwrites an edited hook file, even while it seeds the missing ones", () => {
    adopt({ playbooks: false, profileType: false, hooks: false });
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), '{ "hooks": {} }\n', "utf8");
    execFileSync("git", ["-C", dir, "config", "user.name", "Adopter"]);

    expect(seedPlaybooks(dir, true)).toBeNull();

    // The project's own settings, untouched — not the template's.
    expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toBe('{ "hooks": {} }\n');
    // The script was genuinely absent, so it is still written.
    expect(existsSync(join(dir, ".claude", "hooks", "guard-record.sh"))).toBe(true);
  });

  /**
   * TC-0117 (RQ-0049#AC-3, ST-0066#AC-3). A harness without hook support produces no hook file and
   * no error: the seed writes the playbooks exactly as it did before RQ-0049.
   */
  it("writes no hook file for a harness without hook support, and does not fail", () => {
    adopt({ playbooks: false, profileType: false, hooks: false });
    execFileSync("git", ["-C", dir, "config", "user.name", "Adopter"]);

    expect(seedPlaybooks(dir)).toBeNull();

    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, "docs", "playbooks", "pb-0001.md"))).toBe(true);
  });

  it("refuses when the project already has a playbook, and writes nothing else", () => {
    adopt({ playbooks: true, profileType: true });
    execFileSync("git", ["-C", dir, "config", "user.name", "Adopter"]);
    const before = readFileSync(join(dir, "docs", "playbooks", "pb-0001.md"), "utf8");

    const problem = seedPlaybooks(dir);

    expect(problem).toContain("already has playbook");
    // Untouched, not merely re-seeded to the same content — the refusal happens before any write.
    expect(readFileSync(join(dir, "docs", "playbooks", "pb-0001.md"), "utf8")).toBe(before);
  });
});

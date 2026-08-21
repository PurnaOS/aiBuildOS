import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validate } from "@aibuildos/knowledge-engine";
import { loadBundle, summarize } from "@aibuildos/knowledge-engine/load";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commitAll, git, recentCommits, repoRoot } from "./git.js";
import {
  bundleFiles,
  claimProjectDirectory,
  fillProject,
  harnessSupportsHooks,
  scaffoldProject,
} from "./scaffold.js";

/**
 * TC-0006. A created project is a repository with one commit and a valid, empty OKF bundle.
 *
 * The bundle assertion runs the knowledge engine over the seed. That is what makes it impossible to
 * ship a broken template: a bad seed fails here rather than in every project a user creates.
 */
describe("scaffolding a project", () => {
  let parent: string;

  const IDENTITY = {
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "aibuildos-scaffold-"));
    // Git needs an identity to commit, and CI has none configured globally.
    Object.assign(process.env, IDENTITY);
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
    // Restored, not left set: these beat repo config, so leaking them would make `git.test.ts`'s
    // missing-identity case commit successfully and fail for a reason nobody could see.
    for (const key of Object.keys(IDENTITY)) delete process.env[key];
  });

  it("creates a repository with exactly one commit containing the seed", async () => {
    const dir = await scaffoldProject(parent, "demo");

    expect(await repoRoot(dir)).not.toBeNull();

    const commits = await recentCommits(dir);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.subject).toBe("chore: initial commit");

    // Everything the seed wrote is *in* that commit, not left untracked beside it.
    const tracked = (await git(dir, "ls-tree", "-r", "--name-only", "HEAD")).split("\n");
    expect(tracked).toContain("README.md");
    expect(tracked).toContain("docs/README.md");
    expect(tracked).toContain("docs/profile/requirement.md");

    expect(readFileSync(join(dir, "README.md"), "utf8")).toContain("# demo");
  });

  it("seeds the whole type profile and an index for every artifact directory", async () => {
    const dir = await scaffoldProject(parent, "demo");

    for (const type of [
      "bug",
      "decision",
      "epic",
      "playbook",
      "profile",
      "README",
      "requirement",
      "story",
      "test-case",
      "work-item",
    ]) {
      expect(existsSync(join(dir, "docs", "profile", `${type}.md`))).toBe(true);
    }

    for (const slug of [
      "requirements",
      "epics",
      "user-stories",
      "testing",
      "bugs",
      "decisions",
      "architecture",
      "playbooks",
    ]) {
      expect(existsSync(join(dir, "docs", slug, "README.md"))).toBe(true);
    }

    expect(existsSync(join(dir, "docs", "guidelines", "okf-conventions.md"))).toBe(true);
  });

  it("seeds a bundle the knowledge engine reports no errors on (RQ-0002#AC-4)", async () => {
    const dir = await scaffoldProject(parent, "demo");

    const { bundle, parseErrors } = loadBundle(join(dir, "docs"), dir);

    expect(parseErrors).toEqual([]);
    expect(validate(bundle).filter((finding) => finding.severity === "error")).toEqual([]);
  });

  it("seeds no backlog, but the standard playbooks, owned by whoever the commit is by", async () => {
    // RQ-0013#AC-1, DC-0019: a new project's *backlog* is still empty (RQ-0002#AC-4) — it is not
    // seeded empty of artifacts any more, because the standard playbooks ship from the first commit.
    const dir = await scaffoldProject(parent, "demo");

    const { bundle } = loadBundle(join(dir, "docs"), dir);
    const summary = summarize(bundle);

    for (const type of ["Requirement", "Epic", "Story", "TestCase", "Bug"]) {
      expect(summary.byType[type] ?? 0).toBe(0);
    }
    expect(summary.artifacts).toBe(4);
    expect(summary.byType.Playbook).toBe(4);
    expect(summary.byState.active).toBe(4);
    // The indexes are there waiting for the first requirement.
    expect(summary.indexes).toBeGreaterThanOrEqual(8);

    for (const id of ["pb-0001", "pb-0002", "pb-0003", "pb-0004"]) {
      const text = readFileSync(join(dir, "docs", "playbooks", `${id}.md`), "utf8");
      // The identity `IDENTITY` gave the commit above — never the raw `{{OWNER}}` token.
      expect(text).toContain("owner: Test\n");
      expect(text).not.toContain("{{OWNER}}");
    }
  });

  it("refuses a directory that already exists, and leaves it alone (RQ-0002#AC-3)", async () => {
    const existing = join(parent, "demo");
    mkdirSync(existing);
    writeFileSync(join(existing, "mine.txt"), "do not touch", "utf8");

    await expect(scaffoldProject(parent, "demo")).rejects.toMatchObject({ code: "EEXIST" });

    expect(readFileSync(join(existing, "mine.txt"), "utf8")).toBe("do not touch");
    expect(existsSync(join(existing, "docs"))).toBe(false);
    expect(existsSync(join(existing, ".git"))).toBe(false);
  });

  /**
   * The reason `project:create` registers the project the moment the directory exists. A machine with
   * no Git identity configured is the ordinary first-run state, and the commit is the step it fails
   * at — leaving a real repository with a real bundle and no commit. That has to stay usable, or the
   * user is left with a folder the app made, will not list, and will not create again.
   */
  it("leaves a usable repository behind when the commit fails", async () => {
    for (const key of Object.keys(IDENTITY)) delete process.env[key];

    const dir = claimProjectDirectory(parent, "demo");
    await git(dir, "init", "--quiet");
    await git(dir, "config", "user.name", "");
    await git(dir, "config", "user.email", "");

    await expect(fillProject(dir, "demo")).rejects.toMatchObject({ code: "git_identity" });

    // Not rolled back: the repository, the README and the bundle are all real.
    expect(await repoRoot(dir)).not.toBeNull();
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(existsSync(join(dir, "docs", "profile", "requirement.md"))).toBe(true);
    expect(await recentCommits(dir)).toEqual([]);
  });

  it("carries every template as a non-empty file", () => {
    const files = bundleFiles();

    expect(files.size).toBeGreaterThanOrEqual(20);
    for (const [path, content] of files) {
      // Every template file lives under `docs/`, except the two root instruction files RQ-0028
      // seeds at the project root and the Claude Code guardrail layer RQ-0049 seeds under
      // `.claude/` — not a stray file the glob picked up by accident.
      expect(
        path.startsWith("docs/") ||
          path.startsWith(".claude/") ||
          path === "AGENTS.md" ||
          path === "CLAUDE.md",
        path,
      ).toBe(true);
      expect(content.length, path).toBeGreaterThan(0);
    }
  });

  /**
   * TC-0117 (RQ-0049#AC-1, AC-2). The template ships the record's hard rules as Claude Code hooks:
   * a `.claude/settings.json` that parses and matches the harness's hook schema, wiring PreToolUse
   * on the editing tools to the guard script that denies `state:` edits and protected-file writes.
   */
  it("ships the Claude Code guardrail layer, valid for its harness", () => {
    const files = bundleFiles();

    const settings = files.get(".claude/settings.json");
    expect(settings).toBeDefined();
    // AC-2: valid for its harness — parses, and its shape is the documented hook schema.
    const parsed = JSON.parse(settings ?? "");
    const [matcher] = parsed.hooks.PreToolUse;
    expect(matcher.matcher).toBe("Edit|Write|MultiEdit");
    expect(matcher.hooks).toEqual([
      { type: "command", command: 'sh "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-record.sh"' },
    ]);

    // The script the settings point at ships too, and denies the way Claude Code documents.
    const guard = files.get(".claude/hooks/guard-record.sh");
    expect(guard).toContain("exit 2");
    expect(guard).toContain("docs/profile");
    expect(guard).toContain("state:");
  });

  it("seeds the guardrail hooks beside the instructions, the script executable (RQ-0049#AC-1)", async () => {
    // `true`: a hook-supporting harness is configured — the gate `ipc.ts` computes from the store.
    const dir = await scaffoldProject(parent, "demo", true);

    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(true);
    const script = join(dir, ".claude", "hooks", "guard-record.sh");
    expect(existsSync(script)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(script).mode & 0o111).not.toBe(0);
    }

    // In the initial commit, not left untracked beside it — the guardrails are part of the
    // codebase from initialization, like everything else the seed writes.
    const tracked = (await git(dir, "ls-tree", "-r", "--name-only", "HEAD")).split("\n");
    expect(tracked).toContain(".claude/settings.json");
    expect(tracked).toContain(".claude/hooks/guard-record.sh");
  });

  /**
   * TC-0117 (RQ-0049#AC-3, ST-0066#AC-3). A harness without hook support produces no hook file and
   * no error: the project scaffolds exactly as it did before RQ-0049 — instructions only.
   */
  it("writes no hook file for a harness without hook support, and does not fail", async () => {
    const dir = await scaffoldProject(parent, "demo");

    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    // The create still commits — no error rode along with the absence (RQ-0049#AC-3).
    expect(await recentCommits(dir)).toHaveLength(1);
  });

  /** Hook support is read off the launch spec, the only signal the store keeps. */
  it("recognises a Claude Code launch spec as hook-supporting, and a plainer one as not", () => {
    expect(
      harnessSupportsHooks({
        command: "npx",
        args: ["-y", "@agentclientprotocol/claude-agent-acp"],
      }),
    ).toBe(true);
    expect(harnessSupportsHooks({ command: "claude-code-acp", args: [] })).toBe(true);
    expect(harnessSupportsHooks({ command: "true", args: [] })).toBe(false);
  });

  /**
   * TC-0118 (RQ-0049 / ST-0066#AC-4). The scaffolded hooks are harness hooks, not git hooks: the
   * app's own checkpoint commits (`commitAll`, the same call `checkpointWorktree` rides) succeed
   * in a project carrying them.
   */
  it("does not block the app's own commits in a hook-carrying project", async () => {
    const dir = await scaffoldProject(parent, "demo", true);

    writeFileSync(join(dir, "notes.txt"), "turn work\n", "utf8");
    await commitAll(dir, "checkpoint: ST-0000 turn 1");

    expect(await recentCommits(dir)).toHaveLength(2);
  });

  /**
   * TC-0079 (RQ-0028#AC-1, AC-2). A created project carries root instructions any agent reads —
   * `AGENTS.md` with the substance, `CLAUDE.md` as an import of it — with the owner's state
   * discipline written into `AGENTS.md` word for word where it matters.
   */
  it("seeds root AGENTS.md and CLAUDE.md, CLAUDE.md importing AGENTS.md rather than duplicating it", async () => {
    const dir = await scaffoldProject(parent, "demo");

    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");

    // AC-2: an import, not a second copy that can drift.
    expect(claude).toContain("@AGENTS.md");
    expect(claude).not.toContain("Never edit a `state:` field");

    // AC-2 (ST-0045#AC-2): the owner's state discipline, word for word where it matters — narrowed
    // by ST-0066 to match the guard the same scaffold seeds.
    expect(agents).toContain("## State discipline");
    expect(agents).toContain("Never edit a `state:` field");
    expect(agents.toLowerCase()).toContain("scheduling is the person's");
    expect(agents).toContain("`accepted`, `done`, `rejected`");

    // The regression ST-0066 exists to prevent: the seeded instructions must not promise a state
    // walk that the seeded guard denies. No permission to walk, no walk sequence to follow.
    expect(agents).not.toContain("work states only");
    expect(agents).not.toContain("You may walk");
    expect(agents).not.toContain("ready → queued");
    // The build playbook the same bundle seeds carries no worktree-only escape clause either.
    const playbook = bundleFiles().get("docs/playbooks/pb-0003.md") ?? "";
    expect(playbook).toContain("Leave every `state:` field exactly as you found it");
    expect(playbook).not.toContain("If you are building in a worktree");

    // Nor does the guideline AGENTS.md names by path — an agent reaches it directly, so it has to
    // say the same thing: the state moves on an existing artifact are the person's.
    const guideline = bundleFiles().get("docs/guidelines/requirement-first.md") ?? "";
    expect(guideline).toContain("leave the requirement in `draft`");
    expect(guideline.toLowerCase()).toContain("scheduling is the person's");
    expect(guideline).not.toContain("Move to `state: ready` only once");
    expect(guideline).toContain("old one is the person's move");
    expect(guideline).not.toContain("old one to `retired`");
    // Minting a new artifact still carries its own `state:` — the guard allows it, PB-0001 needs it.
    expect(guideline).toContain("set `state: draft`");
  });
});

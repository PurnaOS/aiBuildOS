import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("./okf-template/.claude/hooks/guard-record.sh", import.meta.url),
);

/** The guard as Claude Code runs it: payload on stdin, exit 2 + stderr is a deny, exit 0 allows. */
function guard(payload: unknown): { denied: boolean; stderr: string } {
  const result = spawnSync("sh", [script], { input: JSON.stringify(payload), encoding: "utf8" });
  if (result.status !== 0 && result.status !== 2) throw new Error(result.stderr);
  return { denied: result.status === 2, stderr: result.stderr };
}

/**
 * TC-0117 (RQ-0049#AC-2). The scaffolded guard script itself, driven with real hook payloads:
 * the record's hard rules deny even an agent that ignored the instructions, and everything else
 * passes through untouched.
 *
 * Skipped on Windows the way the other `sh`-driven suites are — the script is POSIX sh, which is
 * exactly what Claude Code invokes it with.
 */
describe.skipIf(process.platform === "win32")("the scaffolded guard-record hook", () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), "aibuildos-guard-"));
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it("denies an Edit that changes a `state:` line in record markdown", () => {
    const { denied, stderr } = guard({
      tool_name: "Edit",
      tool_input: {
        file_path: join(project, "docs", "user-stories", "st-0001.md"),
        old_string: "state: building\npriority: p1",
        new_string: "state: accepted\npriority: p1",
      },
    });

    expect(denied).toBe(true);
    expect(stderr).toContain("state:");
  });

  it("denies any write into the protected record schema", () => {
    for (const dir of ["profile", "guidelines"]) {
      const { denied, stderr } = guard({
        tool_name: "Write",
        tool_input: {
          file_path: join(project, "docs", dir, "anything.md"),
          content: "rewritten",
        },
      });

      expect(denied, dir).toBe(true);
      expect(stderr).toContain("protected record schema");
    }
  });

  it("denies a Write that rewrites an existing artifact's state", () => {
    const artifact = join(project, "docs", "requirements", "rq-0001.md");
    mkdirSync(join(project, "docs", "requirements"), { recursive: true });
    writeFileSync(artifact, "---\nstate: draft\n---\n", "utf8");

    const rewrite = (state: string) =>
      guard({
        tool_name: "Write",
        tool_input: { file_path: artifact, content: `---\nstate: ${state}\n---\nMore prose.\n` },
      });

    expect(rewrite("ready").denied).toBe(true);
    // The same Write keeping the state as it found it is an ordinary edit.
    expect(rewrite("draft").denied).toBe(false);
  });

  it("allows ordinary work: source files, record prose, and minting a new artifact", () => {
    // A source file is never the guard's business, whatever its content looks like.
    expect(
      guard({
        tool_name: "Edit",
        tool_input: {
          file_path: join(project, "src", "index.ts"),
          old_string: "state: on",
          new_string: "state: off",
        },
      }).denied,
    ).toBe(false);

    // Record prose that leaves the `state:` line alone.
    expect(
      guard({
        tool_name: "Edit",
        tool_input: {
          file_path: join(project, "docs", "requirements", "rq-0001.md"),
          old_string: "old prose",
          new_string: "new prose",
        },
      }).denied,
    ).toBe(false);

    // Minting a new artifact — `state: draft` and all — is legitimate agent work (PB-0001).
    expect(
      guard({
        tool_name: "Write",
        tool_input: {
          file_path: join(project, "docs", "requirements", "rq-0002.md"),
          content: "---\nstate: draft\n---\n",
        },
      }).denied,
    ).toBe(false);

    // A tool call with no file path at all passes straight through.
    expect(guard({ tool_name: "Bash", tool_input: { command: "ls" } }).denied).toBe(false);
  });
});

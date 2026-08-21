import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { extractCheckCommands, killChecks, runChecks } from "./checks.js";

/**
 * TC-0057. Fenced ` ```check ` commands run as real child processes, against a fixture project
 * whose `docs/playbooks/` holds one Playbook artifact.
 *
 * `process.execPath` rather than `node` on `PATH`: this suite runs on whatever Node started Vitest,
 * the one interpreter guaranteed to exist wherever this runs, and all these tests need of a
 * "passing" or "failing" command is a real exit code.
 */
describe("extracting check commands from a body", () => {
  it("takes only the fenced `check` commands, in order, and none from an ordinary fence", () => {
    const body = [
      "# A playbook",
      "",
      "```check",
      "bun run typecheck",
      "```",
      "",
      "```bash",
      "echo not a check",
      "```",
      "",
      "```check",
      "bun run test",
      "```",
    ].join("\n");

    expect(extractCheckCommands(body)).toEqual(["bun run typecheck", "bun run test"]);
  });

  it("ignores a check fence with nothing but whitespace inside it", () => {
    expect(extractCheckCommands(["```check", "   ", "```"].join("\n"))).toEqual([]);
  });
});

describe("running the project's checks", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aibuildos-checks-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Writes one Playbook artifact whose body is one ` ```check ` fence per command given. */
  function writePlaybook(id: string, state: string, commands: string[]): void {
    const playbooksDir = join(dir, "docs", "playbooks");
    mkdirSync(playbooksDir, { recursive: true });
    const fences = commands.map((command) => `\`\`\`check\n${command}\n\`\`\``).join("\n\n");
    writeFileSync(
      join(playbooksDir, `${id}.md`),
      `---\ntype: Playbook\nid: ${id.toUpperCase()}\ntitle: "Run the checks"\nstate: ${state}\n` +
        `owner: test\nprovenance: agent\ncreated: 2026-08-20\n---\n\n# ${id.toUpperCase()}\n\n${fences}\n`,
      "utf8",
    );
  }

  it("reports no checks when the project has no playbook, and when one has no check fence", async () => {
    const noPlaybook = await runChecks(dir, () => {});
    expect(noPlaybook.results).toEqual([]);
    expect(noPlaybook.problem).toContain("declares no checks");

    writePlaybook("pb-0001", "active", []);
    const noFences = await runChecks(dir, () => {});
    expect(noFences.results).toEqual([]);
    expect(noFences.problem).toContain("declares no checks");
  });

  it("ignores a retired playbook's fences", async () => {
    writePlaybook("pb-0001", "retired", [`"${process.execPath}" -e "process.exit(0)"`]);
    const { results, problem } = await runChecks(dir, () => {});
    expect(results).toEqual([]);
    expect(problem).toContain("declares no checks");
  });

  it("runs a passing, a failing and a nonexistent command, exit code the whole verdict", async () => {
    const pass = `"${process.execPath}" -e "console.log('hello'); process.exit(0)"`;
    const fail = `"${process.execPath}" -e "process.exit(1)"`;
    const missing = "aibuildos-test-command-does-not-exist";
    writePlaybook("pb-0001", "active", [pass, fail, missing]);

    const output: { command: string; chunk: string }[] = [];
    const { results, problem } = await runChecks(dir, (command, chunk) =>
      output.push({ command, chunk }),
    );

    expect(problem).toBeNull();
    // 127 is `sh`'s convention for "the shell ran, the named command did not exist". Windows has no
    // honest equivalent through node's `cmd /d /s /c` path — an unknown command exits 1, the same
    // as any failing command (CI-proven) — so there `could_not_run` is simply `failed`.
    const missingResult =
      process.platform === "win32"
        ? { command: missing, outcome: "failed" as const, exitCode: 1 }
        : { command: missing, outcome: "could_not_run" as const, exitCode: 127 };
    expect(results).toEqual([
      { command: pass, outcome: "passed", exitCode: 0 },
      { command: fail, outcome: "failed", exitCode: 1 },
      missingResult,
    ]);
    // Captured as it streamed, not reconstructed after the fact: the chunk arrived through the
    // callback while `pass` was still running.
    expect(output.some((line) => line.command === pass && line.chunk.includes("hello"))).toBe(true);
  });

  it("kills a long-running check when the application is closing", async () => {
    const marker = "aibuildos-check-running";
    const long = `"${process.execPath}" -e "console.log('${marker}'); setTimeout(() => {}, 5000);"`;
    writePlaybook("pb-0001", "active", [long]);

    let sawMarker = (): void => undefined;
    const running = new Promise<void>((resolve) => {
      sawMarker = resolve;
    });

    const run = runChecks(dir, (_command, chunk) => {
      if (chunk.includes(marker)) sawMarker();
    });

    // Only kill once the process is confirmed running — not a timed guess.
    await running;
    killChecks();

    const settled = await Promise.race([
      run.then((result) => ({ timedOut: false as const, result })),
      new Promise<{ timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), 4000),
      ),
    ]);

    expect(settled.timedOut).toBe(false);
    if (!settled.timedOut) {
      expect(settled.result.results[0]?.outcome).not.toBe("passed");
    }
  });
});

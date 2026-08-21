import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prStatus } from "./pr.js";

/**
 * RQ-0034. `gh` is an optional binary, so `AIBUILDOS_GH_BIN` (DC-0024) is the whole test seam —
 * no real `gh`, no network. The stub scripts shebang the exact `node` that ran this suite
 * (`process.execPath`), never `/bin/sh` or `env node`, so the seam does not depend on `PATH`.
 * Shebangs are POSIX-only, so the happy and non-zero-exit paths skip on win32; ENOENT does not.
 */
describe("PR status via gh (RQ-0034)", () => {
  let dir: string;
  const originalBin = process.env.AIBUILDOS_GH_BIN;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aibuildos-pr-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalBin === undefined) delete process.env.AIBUILDOS_GH_BIN;
    else process.env.AIBUILDOS_GH_BIN = originalBin;
  });

  /** A stub `gh` that ignores its argv and prints `body` to stdout, or writes `body` to stderr and
   * exits 1 when `fail` is set. */
  function writeStub(body: string, fail = false): string {
    const path = join(dir, "gh-stub");
    const script = fail
      ? `process.stderr.write(${JSON.stringify(body)});\nprocess.exit(1);\n`
      : `process.stdout.write(${JSON.stringify(body)});\n`;
    writeFileSync(path, `#!${process.execPath}\n${script}`, "utf8");
    chmodSync(path, 0o755);
    return path;
  }

  it.skipIf(process.platform === "win32")(
    "maps gh's JSON, tolerating both check-run and legacy status shapes",
    async () => {
      const json = JSON.stringify({
        url: "https://github.com/acme/repo/pull/7",
        state: "OPEN",
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        statusCheckRollup: [
          { name: "build", conclusion: "SUCCESS" },
          { context: "legacy-ci", state: "success" },
          {},
        ],
      });
      process.env.AIBUILDOS_GH_BIN = writeStub(json);

      const result = await prStatus(dir);

      expect(result).toEqual({
        ok: true,
        url: "https://github.com/acme/repo/pull/7",
        state: "OPEN",
        mergeable: "MERGEABLE",
        reviewDecision: "APPROVED",
        checks: [
          { name: "build", status: "SUCCESS" },
          { name: "legacy-ci", status: "success" },
          { name: "check", status: "unknown" },
        ],
      });
    },
  );

  it("reports gh_missing when the binary does not exist, not an exception", async () => {
    process.env.AIBUILDOS_GH_BIN = join(dir, "no-such-binary");

    const result = await prStatus(dir);

    expect(result).toMatchObject({ ok: false, code: "gh_missing" });
    if (!result.ok) {
      expect(result.message).toMatch(/cli\.github\.com/);
      expect(result.message).toMatch(/gh auth login/);
    }
  });

  it.skipIf(process.platform === "win32")(
    "carries gh's own stderr when it exits non-zero",
    async () => {
      process.env.AIBUILDOS_GH_BIN = writeStub("no pull requests found for branch\n", true);

      const result = await prStatus(dir);

      expect(result).toMatchObject({ ok: false, code: "gh_failed" });
      if (!result.ok) expect(result.message).toContain("no pull requests found for branch");
    },
  );
});

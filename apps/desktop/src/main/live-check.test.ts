import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_PRESETS } from "@aibuildos/acp";
import { probeHarness } from "@aibuildos/acp/probe";
import { validate } from "@aibuildos/knowledge-engine";
import { loadBundle } from "@aibuildos/knowledge-engine/load";
import { afterAll, expect, it } from "vitest";
import { scaffoldProject } from "./scaffold.js";

/**
 * A live check, against a **real** agent — deliberately skipped unless asked for:
 *
 *     AIBUILDOS_LIVE=1 bun run test
 *
 * Automated verification never needs a live model ([DC-0013](../../../docs/decisions/dc-0013.md)), so
 * this is not bound to a TestCase and does not run in CI. It exists because everything this product
 * does rests on a real agent actually connecting, and the stub cannot tell us that it does.
 *
 * It creates a project the way the application does, then asks a real Claude Code to answer inside it.
 */
const live = process.env.AIBUILDOS_LIVE === "1";
const parent = live ? mkdtempSync(join(tmpdir(), "aibuildos-live-")) : "";

afterAll(() => {
  if (parent) rmSync(parent, { recursive: true, force: true });
});

it.skipIf(!live)(
  "creates a project and a real Claude Code answers inside it",
  async () => {
    Object.assign(process.env, {
      GIT_AUTHOR_NAME: "aiBuildOS live check",
      GIT_AUTHOR_EMAIL: "live@example.com",
      GIT_COMMITTER_NAME: "aiBuildOS live check",
      GIT_COMMITTER_EMAIL: "live@example.com",
    });

    const dir = await scaffoldProject(parent, "live-demo");
    expect(existsSync(join(dir, ".git"))).toBe(true);

    // The seeded bundle has to be valid in a project that was really created, not only in a fixture.
    const { bundle } = loadBundle(join(dir, "docs"), dir);
    expect(validate(bundle).filter((f) => f.severity === "error")).toEqual([]);

    const preset = HARNESS_PRESETS.find((candidate) => candidate.id === "claude-code");
    if (!preset) throw new Error("the claude-code preset is missing");

    const result = await probeHarness(
      { command: preset.command, args: preset.args },
      { cwd: dir, timeoutMs: 180_000, clientVersion: "0.1.0" },
    );

    if (!result.ok) {
      throw new Error(
        `${result.stage}/${result.code}: ${result.message}\n${result.stderr.slice(-800)}`,
      );
    }

    expect(result.protocolVersion).toBe(1);
    expect(result.sessionId).not.toBe("");
    expect(result.reply.trim()).toBe("ok");
    expect(result.stopReason).toBe("end_turn");
  },
  200_000,
);

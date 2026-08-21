import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CUSTOM } from "@aibuildos/acp/bridge";
import type { EventPayload } from "@aibuildos/ipc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Harness } from "./harnesses.js";
import { SessionRegistry, type SupervisionLevel } from "./sessions.js";

/**
 * TC-0060. The supervision policy at the permission flow in main: closest blocks for a person exactly
 * as it always has, hands-off answers with the agent's own allow option and says so, and a level
 * changed mid-session applies from the next request rather than reaching back into one already asked.
 *
 * Against the scripted stub's `--mode=permission`, spawned as a real subprocess — the same discipline
 * `packages/acp/src/session.test.ts` uses for the protocol round trip this policy sits in front of.
 */
const stub = fileURLToPath(
  new URL("../../../../tools/stub-acp-agent/src/agent.ts", import.meta.url),
);

const harness: Harness = {
  id: "stub",
  displayName: "Stub",
  command: process.execPath,
  args: ["--experimental-strip-types", stub, "--mode=permission"],
};

interface PermissionValue {
  requestId: string;
  automatic?: boolean;
}

/** Poll until true, rather than a fixed sleep — the stub answers as soon as its round trip lands. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("the supervision policy", () => {
  let cwd: string;
  let registry: SessionRegistry;
  let permissionEvents: PermissionValue[];
  let level: SupervisionLevel;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "aibuildos-sessions-"));
    permissionEvents = [];
    level = "closest";
    registry = new SessionRegistry(
      (event, payload) => {
        if (event !== "session:event") return;
        const { name, value } = (payload as EventPayload<"session:event">).event as unknown as {
          name?: string;
          value?: unknown;
        };
        if (name === CUSTOM.permission) permissionEvents.push(value as PermissionValue);
      },
      () => level,
    );
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const start = async () => {
    const result = await registry.start(harness, "project-1", cwd, "1.0.0");
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.sessionId;
  };

  it("blocks at the closest level until a person answers", async () => {
    const sessionId = await start();

    const turn = registry.prompt(sessionId, "run the tests");
    await waitFor(() => permissionEvents.length === 1);

    // Not answered on its own: nothing has resolved the prompt yet.
    expect(permissionEvents[0]?.automatic).toBeUndefined();

    registry.answerPermission(sessionId, permissionEvents[0]?.requestId ?? "", "allow-once");
    expect(await turn).toEqual({ stopReason: "end_turn" });

    await registry.close(sessionId);
  });

  it("answers a hands-off request with the agent's own allow option, marked automatic", async () => {
    level = "hands-off";
    const sessionId = await start();

    // No `answerPermission` call anywhere in this test: the policy has to answer on its own, before
    // a person ever could.
    const turn = await registry.prompt(sessionId, "run the tests");

    expect(permissionEvents).toHaveLength(1);
    expect(permissionEvents[0]?.automatic).toBe(true);
    // "allow-once" is what the stub's own options offer first (TC-0015) — proceeding at all, rather
    // than the stub's "did not run it" refusal text, is proof the right option was picked.
    expect(turn).toEqual({ stopReason: "end_turn" });

    await registry.close(sessionId);
  });

  it("applies a level changed mid-session to the next request, not the one already asked", async () => {
    const sessionId = await start();

    const first = registry.prompt(sessionId, "run the tests");
    await waitFor(() => permissionEvents.length === 1);
    expect(permissionEvents[0]?.automatic).toBeUndefined();

    // Flipped after the first request went out, before it was answered.
    level = "hands-off";

    // Still has to be answered by hand: the change does not reach back for what is already pending.
    registry.answerPermission(sessionId, permissionEvents[0]?.requestId ?? "", "allow-once");
    await first;

    await registry.prompt(sessionId, "run the tests");
    expect(permissionEvents).toHaveLength(2);
    expect(permissionEvents[1]?.automatic).toBe(true);

    await registry.close(sessionId);
  });
});

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { probeHarness } from "./probe.js";

/**
 * TC-0002 and TC-0003. Everything here runs against `tools/stub-acp-agent` — a real JSON-RPC stdio
 * binary — so the spawn path and the wire handling are exercised for real, offline and free
 * (DC-0013). The stub's failure modes are selected through argv, the same `{ command, args }` shape
 * a configured harness uses.
 */
const STUB = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

const stub = (mode?: string) => ({
  command: process.execPath,
  args: mode ? [STUB, `--mode=${mode}`] : [STUB],
});

const cwd = process.cwd();

describe("probeHarness — TC-0002, the round trip", () => {
  it("completes handshake, session and prompt, and reports what the agent advertised", async () => {
    const result = await probeHarness(stub(), { cwd, timeoutMs: 20_000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.protocolVersion).toBe(1);
    expect(result.agentInfo).toEqual({ name: "stub-acp-agent", version: "0.1.0" });
    expect(result.sessionId).toBe("stub-session");
    expect(result.reply).toBe("ok");
    expect(result.stopReason).toBe("end_turn");
    expect(result.authMethods).toEqual([]);
  });
});

describe("probeHarness — TC-0003, the failure modes", () => {
  it("reports a command that is not on PATH", async () => {
    const result = await probeHarness(
      { command: "aibuildos-no-such-binary", args: [] },
      { cwd, timeoutMs: 5_000 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("spawn");
    expect(result.code).toBe("command_not_found");
  });

  it("reports a process that exits before the handshake, and keeps its stderr", async () => {
    const result = await probeHarness(
      { command: process.execPath, args: ["-e", 'process.stderr.write("boom"); process.exit(3)'] },
      { cwd, timeoutMs: 5_000 },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("exited");
    expect(result.stderr).toContain("boom");
  });

  it("times out on an agent that never answers, within the timeout budget", async () => {
    const started = Date.now();
    const result = await probeHarness(stub("silent"), { cwd, timeoutMs: 750 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports authentication as its own outcome, with the methods the agent offers", async () => {
    const result = await probeHarness(stub("auth-required"), { cwd, timeoutMs: 20_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("session");
    expect(result.code).toBe("auth_required");
    expect(result.authMethods).toEqual([{ id: "stub-login", name: "Log in to the stub" }]);
  });
});

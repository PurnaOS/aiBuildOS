import { execFileSync } from "node:child_process";
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

/**
 * `--experimental-strip-types` is what lets Node run the stub's TypeScript source directly. It is
 * the default from Node 22.18, but `engines` admits 22.0, where omitting it fails the spawn for a
 * reason that has nothing to do with the code under test.
 */
const stub = (mode?: string) => ({
  command: process.execPath,
  args: mode
    ? ["--experimental-strip-types", STUB, `--mode=${mode}`]
    : ["--experimental-strip-types", STUB],
});

const cwd = process.cwd();

/**
 * Live processes whose command line carries the marker. `pgrep` runs directly — wrapped in
 * `sh -c`, Linux's pgrep matches the wrapper shell itself (its argv carries the marker) and
 * reports a survivor that never existed. Exit code 1 is pgrep's word for "none".
 */
function survivorsOf(marker: string): string {
  try {
    return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

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

  it("blames the working directory, not PATH, when the working directory does not exist", async () => {
    // Both faults raise ENOENT with the *command* in `error.path`, so this is the one failure the
    // probe cannot tell apart after the fact — it has to be ruled out first.
    const result = await probeHarness(stub(), {
      cwd: "/definitely/not/a/directory",
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("cwd_not_found");
  });

  it.skipIf(process.platform === "win32")(
    "reaps a grandchild process, not just the launcher it spawned",
    async () => {
      // The shipped presets are all `npx -y <pkg>`, so the agent is a grandchild of the process the
      // probe holds. `sh -c` reproduces that shape offline: a marker process in the background, and
      // the stub `exec`d in the foreground so the probe hangs long enough to time out.
      const marker = "aibuildos-orphan-probe";
      const result = await probeHarness(
        {
          command: "/bin/sh",
          args: [
            "-c",
            `${process.execPath} -e 'setTimeout(()=>{},30000)' ${marker} & ` +
              `exec ${process.execPath} --experimental-strip-types ${STUB} --mode=silent`,
          ],
        },
        { cwd, timeoutMs: 750 },
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("timeout");

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(survivorsOf(marker)).toBe("");
    },
    20_000,
  );

  it("reports authentication as its own outcome, with the methods the agent offers", async () => {
    const result = await probeHarness(stub("auth-required"), { cwd, timeoutMs: 20_000 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("session");
    expect(result.code).toBe("auth_required");
    expect(result.authMethods).toEqual([{ id: "stub-login", name: "Log in to the stub" }]);
  });
});

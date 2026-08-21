import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const agent = fileURLToPath(new URL("./agent.ts", import.meta.url));

/** Spawn the stub the way the app spawns a real agent, and collect one reply per request. */
async function exchange(
  requests: unknown[],
  expected = requests.length,
  args: string[] = [],
  /** Answer a message the stub sends *us* — the client half of the wire. `undefined` ignores it. */
  answer?: (message: { id?: number; method?: string }) => unknown,
): Promise<unknown[]> {
  // `--experimental-strip-types` lets Node run the .ts source directly, matching how the built app
  // will spawn a compiled agent binary: a child process over stdio, nothing mocked.
  const child = spawn(process.execPath, ["--experimental-strip-types", agent, ...args], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const replies: unknown[] = [];
  const done = new Promise<void>((resolve) => {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      const message = JSON.parse(line) as { id?: number; method?: string };
      replies.push(message);
      const result = answer?.(message);
      if (result !== undefined && message.id !== undefined) {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      }
      if (replies.length === expected) resolve();
    });
    child.on("exit", () => resolve());
  });

  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  await done;
  child.stdin.end();
  child.kill();
  return replies;
}

describe("stub ACP agent", () => {
  it("answers initialize and session/prompt over stdio", async () => {
    const replies = await exchange(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { jsonrpc: "2.0", id: 2, method: "session/prompt", params: { prompt: "hello" } },
      ],
      3,
    );

    expect(replies).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: {
          protocolVersion: 1,
          agentCapabilities: {},
          agentInfo: { name: "stub-acp-agent", version: "0.1.0" },
        },
      },
      // A real agent streams its text before it answers the prompt; so does the stub.
      {
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "stub-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ok" },
          },
        },
      },
      { jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } },
    ]);
  }, 20_000);

  it("reports unknown methods as JSON-RPC errors", async () => {
    const [reply] = await exchange([{ jsonrpc: "2.0", id: 7, method: "nope" }]);
    expect(reply).toMatchObject({ id: 7, error: { code: -32601 } });
  }, 20_000);

  it("advertises the typed-record extension in `_meta` only in typed-record mode", async () => {
    const [advertising] = await exchange(
      [{ jsonrpc: "2.0", id: 1, method: "initialize" }],
      1,
      ["--mode=typed-record"],
    );
    expect(advertising).toMatchObject({
      result: { agentCapabilities: { _meta: { "aibuildos/typed-record": { version: 1 } } } },
    });

    const [baseline] = await exchange([{ jsonrpc: "2.0", id: 1, method: "initialize" }]);
    expect(baseline).toMatchObject({ result: { agentCapabilities: {} } });
  }, 20_000);

  it("proposes a conforming typed plan and acts on the acceptance", async () => {
    const replies = await exchange(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { jsonrpc: "2.0", id: 2, method: "session/new" },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: { prompt: [{ type: "text", text: "Plan RQ-0001" }] },
        },
      ],
      // initialize, session/new, the plan request, the chunk, the prompt result.
      5,
      ["--mode=typed-record"],
      (message) =>
        message.method === "_aibuildos/plan"
          ? { accepted: true, ids: ["ST-0001", "TC-0001"] }
          : undefined,
    );

    const proposal = replies.find(
      (reply) => (reply as { method?: string }).method === "_aibuildos/plan",
    ) as { params: { _meta: unknown; stories: unknown[]; testCases: unknown[] } };
    expect(proposal.params._meta).toEqual({ "aibuildos/typed-record": { attempt: 1 } });
    expect(proposal.params.stories).toEqual([
      {
        title: "Deliver RQ-0001",
        implements: ["RQ-0001"],
        criteria: ["The behaviour RQ-0001 asks for is observable."],
      },
    ]);
    expect(proposal.params.testCases).toEqual([
      {
        title: "RQ-0001 behaves as asked",
        kind: "automated",
        verifies: ["RQ-0001"],
        steps: ["Exercise RQ-0001 and expect what it promises."],
      },
    ]);
    expect(JSON.stringify(replies)).toContain("Proposed 1 typed stories.");
  }, 20_000);

  it("emits a typed verdict notification for a checks prompt", async () => {
    const replies = await exchange(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { jsonrpc: "2.0", id: 2, method: "session/new" },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: { prompt: [{ type: "text", text: "run the checks for TC-0002" }] },
        },
      ],
      // initialize, session/new, the verdict notification, the chunk, the prompt result.
      5,
      ["--mode=typed-record"],
    );

    const verdict = replies.find(
      (reply) => (reply as { method?: string }).method === "_aibuildos/verdict",
    ) as { id?: number; params: unknown };
    // A notification: no id, and the exact typed shape the application's schema expects.
    expect(verdict.id).toBeUndefined();
    expect(verdict.params).toEqual({
      sessionId: "stub-session",
      testCaseId: "TC-0002",
      result: "passed",
      ranAt: "2026-08-20T00:00:00Z",
    });
  }, 20_000);

  it("persists a config option change across a later one", async () => {
    const replies = await exchange(
      [
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "session/set_config_option",
          params: { sessionId: "stub-session", configId: "model", value: "opus" },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "session/set_config_option",
          params: { sessionId: "stub-session", configId: "thought_level", value: "think_hard" },
        },
      ],
      // Each set answers and also pushes a config_option_update: 1 + 2 + 2.
      5,
      ["--mode=controls"],
    );

    // The second answer still carries the first change — mapping over the list and forgetting the
    // result was a real stub bug, and this is the case that keeps it fixed.
    const second = replies.find((reply) => (reply as { id?: number }).id === 3) as {
      result: { configOptions: { id: string; currentValue: string }[] };
    };
    const values = new Map(
      second.result.configOptions.map((option) => [option.id, option.currentValue]),
    );
    expect(values.get("model")).toBe("opus");
    expect(values.get("thought_level")).toBe("think_hard");
    // ST-0067's permission-flavoured entry rides along untouched.
    expect(values.get("permission_mode")).toBe("ask");
  }, 20_000);
});

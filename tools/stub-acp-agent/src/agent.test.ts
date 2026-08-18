import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const agent = fileURLToPath(new URL("./agent.ts", import.meta.url));

/** Spawn the stub the way the app spawns a real agent, and collect one reply per request. */
async function exchange(requests: unknown[], expected = requests.length): Promise<unknown[]> {
  // `--experimental-strip-types` lets Node run the .ts source directly, matching how the built app
  // will spawn a compiled agent binary: a child process over stdio, nothing mocked.
  const child = spawn(process.execPath, ["--experimental-strip-types", agent], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const replies: unknown[] = [];
  const done = new Promise<void>((resolve) => {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (line.trim()) replies.push(JSON.parse(line));
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
});

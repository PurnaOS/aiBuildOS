#!/usr/bin/env node
/**
 * A scripted ACP agent: a real JSON-RPC-over-stdio binary that replays canned responses (DC-0013).
 *
 * It is spawned exactly like a real agent, so the spawn path and the wire handling are genuinely
 * under test rather than mocked away. No live model is ever called in CI.
 *
 * The failure modes are scripted through argv rather than the environment, because a harness is
 * `{ command, args }` and nothing else — so a test can reach every branch with the same
 * configuration shape the product uses:
 *
 *   --mode=ok             the happy path: handshake, session, one streamed reply (default)
 *   --mode=silent         reads input, answers nothing — drives the probe's timeout
 *   --mode=exit           exits immediately without speaking
 *   --mode=auth-required  fails `session/new` with JSON-RPC -32000
 *
 * Node-compatible on purpose: it stands in for an agent binary, and agent binaries are not Bun.
 */
import { createInterface } from "node:readline";

type Mode = "ok" | "silent" | "exit" | "auth-required";

interface Request {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

const mode = (process.argv
  .find((argument) => argument.startsWith("--mode="))
  ?.slice("--mode=".length) ?? "ok") as Mode;

if (mode === "exit") process.exit(3);

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return; // a notification takes no reply
  write({ jsonrpc: "2.0", id, result });
}

function fail(id: number | string | undefined, code: number, message: string): void {
  if (id === undefined) return;
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  if (line.trim() === "" || mode === "silent") return;

  let request: Request;
  try {
    request = JSON.parse(line) as Request;
  } catch {
    fail(undefined, -32700, "parse error");
    return;
  }

  switch (request.method) {
    case "initialize":
      respond(request.id, {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "stub-acp-agent", version: "0.1.0" },
        ...(mode === "auth-required"
          ? { authMethods: [{ id: "stub-login", name: "Log in to the stub" }] }
          : {}),
      });
      break;
    case "session/new":
      if (mode === "auth-required") fail(request.id, -32000, "Authentication required");
      else respond(request.id, { sessionId: "stub-session" });
      break;
    case "session/prompt": {
      // Stream the reply before answering, exactly as a real agent does: the client accumulates
      // `agent_message_chunk` updates and stops on the response.
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "stub-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "ok" },
          },
        },
      });
      respond(request.id, { stopReason: "end_turn" });
      break;
    }
    case "shutdown":
      respond(request.id, null);
      lines.close();
      break;
    default:
      fail(request.id, -32601, `method not found: ${request.method}`);
  }
});

lines.on("close", () => process.exit(0));

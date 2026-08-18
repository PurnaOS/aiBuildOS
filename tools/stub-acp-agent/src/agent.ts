#!/usr/bin/env node
/**
 * A scripted ACP agent: a real JSON-RPC-over-stdio binary that replays canned responses (DC-0013).
 *
 * It is spawned exactly like a real agent, so the spawn path and the wire handling are genuinely
 * under test rather than mocked away. No live model is ever called in CI.
 *
 * Node-compatible on purpose: it stands in for an agent binary, and agent binaries are not Bun.
 */
import { createInterface } from "node:readline";

interface Request {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

function respond(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return; // a notification takes no reply
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id: number | string | undefined, code: number, message: string): void {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  if (line.trim() === "") return;

  let request: Request;
  try {
    request = JSON.parse(line) as Request;
  } catch {
    fail(undefined, -32700, "parse error");
    return;
  }

  switch (request.method) {
    case "initialize":
      respond(request.id, { protocolVersion: 1, agentCapabilities: {} });
      break;
    case "session/new":
      respond(request.id, { sessionId: "stub-session" });
      break;
    case "session/prompt":
      respond(request.id, { stopReason: "end_turn" });
      break;
    case "shutdown":
      respond(request.id, null);
      lines.close();
      break;
    default:
      fail(request.id, -32601, `method not found: ${request.method}`);
  }
});

lines.on("close", () => process.exit(0));

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
 *   --mode=auth-required  fails `session/new` with JSON-RPC -32000
 *   --mode=rich           a realistic turn: thought, tool call, diff, plan, reply, usage
 *   --mode=permission     asks the client for permission, and obeys the answer
 *   --mode=slow           streams slowly and honours `session/cancel`
 *   --mode=controls       advertises modes and config options, and confirms changes to them
 *
 * The last four exist because a live agent does far more than stream text, and a stub that only
 * streams text can only test streaming text.
 *
 * Node-compatible on purpose: it stands in for an agent binary, and agent binaries are not Bun.
 */
import { createInterface } from "node:readline";

type Mode = "ok" | "silent" | "auth-required" | "rich" | "permission" | "slow" | "controls";

interface Message {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

const mode = (process.argv
  .find((argument) => argument.startsWith("--mode="))
  ?.slice("--mode=".length) ?? "ok") as Mode;

const SESSION = "stub-session";

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

/** One `session/update` notification. */
function update(payload: unknown): void {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: { sessionId: SESSION, update: payload },
  });
}

const chunk = (text: string, messageId?: string): void =>
  update({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    ...(messageId === undefined ? {} : { messageId }),
  });

/**
 * Calling the *client*, which is the half a stub usually forgets it has. A permission request is a
 * request from the agent, so the stub has to issue one and wait for the answer to come back.
 */
let nextId = 1000;
const pending = new Map<number, (result: unknown) => void>();

function callClient(method: string, params: unknown): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    write({ jsonrpc: "2.0", id, method, params });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Set by the `session/cancel` notification, which takes no reply. */
let cancelled = false;

const MODES = {
  currentModeId: "plan",
  availableModes: [
    { id: "plan", name: "Plan" },
    { id: "code", name: "Code" },
  ],
};

const CONFIG_OPTIONS = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "sonnet",
    options: [
      { id: "sonnet", name: "Sonnet" },
      { id: "opus", name: "Opus" },
    ],
  },
  {
    id: "thought_level",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "think",
    options: [
      { id: "think", name: "Think" },
      { id: "think_hard", name: "Think hard" },
    ],
  },
];

/** A turn with every kind of update a real agent produces. */
async function richTurn(): Promise<string> {
  update({
    sessionUpdate: "plan",
    entries: [
      { content: "Read the file", priority: "medium", status: "in_progress" },
      { content: "Edit it", priority: "medium", status: "pending" },
    ],
  });

  update({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Looking at how this is laid out" },
    messageId: "thought-1",
  });

  update({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "Edit ui.ts",
    kind: "edit",
    status: "pending",
    rawInput: { path: "ui.ts" },
    locations: [{ path: "/tmp/demo/ui.ts", line: 24 }],
  });

  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "call-1",
    status: "completed",
    content: [
      {
        type: "diff",
        path: "/tmp/demo/ui.ts",
        oldText: "export const gap = 2;\n",
        newText: "export const gap = 4;\n",
      },
    ],
  });

  update({
    sessionUpdate: "plan",
    entries: [
      { content: "Read the file", priority: "medium", status: "completed" },
      { content: "Edit it", priority: "medium", status: "completed" },
    ],
  });

  chunk("Done: ", "message-1");
  chunk("the gap is now 4.", "message-1");
  update({ sessionUpdate: "usage_update", used: 1234, size: 200000 });

  return "end_turn";
}

async function permissionTurn(): Promise<string> {
  update({
    sessionUpdate: "tool_call",
    toolCallId: "call-1",
    title: "Run bun test",
    kind: "execute",
    status: "pending",
  });

  const answer = (await callClient("session/request_permission", {
    sessionId: SESSION,
    toolCall: { toolCallId: "call-1", title: "Run bun test", kind: "execute" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  })) as { outcome?: { outcome?: string; optionId?: string } };

  const outcome = answer?.outcome?.outcome;
  if (outcome === "cancelled") {
    chunk("Stopped before running anything.", "message-1");
    return "cancelled";
  }
  if (answer?.outcome?.optionId === "reject") {
    update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed" });
    chunk("I did not run it.", "message-1");
    return "end_turn";
  }

  update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed" });
  chunk("Tests passed.", "message-1");
  return "end_turn";
}

/**
 * Streams with pauses so a cancel can land mid-turn — and keeps sending afterwards, because the
 * protocol says a client must go on accepting updates after cancelling.
 */
async function slowTurn(): Promise<string> {
  for (let index = 0; index < 20; index += 1) {
    if (cancelled) {
      update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed" });
      chunk(" [stopped]", "message-1");
      return "cancelled";
    }
    chunk(`${index} `, "message-1");
    await sleep(25);
  }
  return "end_turn";
}

const lines = createInterface({ input: process.stdin });

lines.on("line", (line) => {
  void handle(line);
});

async function handle(line: string): Promise<void> {
  if (line.trim() === "" || mode === "silent") return;

  let message: Message;
  try {
    message = JSON.parse(line) as Message;
  } catch {
    fail(undefined, -32700, "parse error");
    return;
  }

  // A reply to something this stub asked the client.
  if (message.method === undefined && typeof message.id === "number") {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message.result);
    }
    return;
  }

  switch (message.method) {
    case "initialize":
      respond(message.id, {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: "stub-acp-agent", version: "0.1.0" },
        ...(mode === "auth-required"
          ? { authMethods: [{ id: "stub-login", name: "Log in to the stub" }] }
          : {}),
      });
      break;

    case "session/new":
      if (mode === "auth-required") {
        fail(message.id, -32000, "Authentication required");
        break;
      }
      respond(message.id, {
        sessionId: SESSION,
        // Only the controls mode advertises these, so a test can prove that an agent offering
        // nothing produces no controls at all.
        ...(mode === "controls" ? { modes: MODES, configOptions: CONFIG_OPTIONS } : {}),
      });
      if (mode === "controls") {
        update({
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "review", description: "Review the working tree" }],
        });
      }
      break;

    case "session/set_mode":
      respond(message.id, {});
      update({
        sessionUpdate: "current_mode_update",
        currentModeId: (message.params as { modeId?: string })?.modeId ?? "plan",
      });
      break;

    case "session/set_config_option": {
      const params = message.params as { optionId?: string; value?: string };
      const next = CONFIG_OPTIONS.map((option) =>
        option.id === params?.optionId ? { ...option, currentValue: params?.value } : option,
      );
      respond(message.id, { configOptions: next });
      update({ sessionUpdate: "config_option_update", configOptions: next });
      break;
    }

    case "session/cancel":
      // A notification: no reply, and the in-flight turn resolves itself as cancelled.
      cancelled = true;
      break;

    case "session/prompt": {
      cancelled = false;
      let stopReason = "end_turn";
      if (mode === "rich") stopReason = await richTurn();
      else if (mode === "permission") stopReason = await permissionTurn();
      else if (mode === "slow") stopReason = await slowTurn();
      else chunk("ok");

      respond(message.id, { stopReason });
      break;
    }

    case "shutdown":
      respond(message.id, null);
      lines.close();
      break;

    default:
      fail(message.id, -32601, `method not found: ${message.method}`);
  }
}

lines.on("close", () => process.exit(0));

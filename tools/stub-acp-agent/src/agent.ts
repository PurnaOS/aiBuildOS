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
 *   --mode=controls       advertises modes and config options, confirms changes to them, echoes
 *                         prompts, and re-advertises its commands as turns pass (ST-0069)
 *   --mode=echo           replies with exactly the prompt text received — proves what was sent
 *   --mode=plan-writer    writes a scripted draft story + test per RQ id found in the prompt
 *   --mode=file-writer    appends a scripted line to notes.md each turn, with tool call and diff
 *   --mode=question       asks one fenced aibuildos-question, then echoes the answer back
 *   --mode=interview      two scripted questions, then writes one draft requirement
 *   --mode=journey        first prompt plans like plan-writer, later prompts build like file-writer
 *   --mode=exec-streamer  one execute tool call whose output streams in chunks before it ends
 *   --mode=typed-record   advertises the aibuildos/typed-record extension (DC-0028): a plan prompt
 *                         sends a typed `_aibuildos/plan` request (add `--flaky-plan` for a
 *                         non-conforming first attempt that retries on rejection), a "run the
 *                         checks" prompt emits a typed `_aibuildos/verdict` notification
 *
 * The last four exist because a live agent does far more than stream text, and a stub that only
 * streams text can only test streaming text.
 *
 * Node-compatible on purpose: it stands in for an agent binary, and agent binaries are not Bun.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

type Mode =
  | "ok"
  | "silent"
  | "auth-required"
  | "rich"
  | "permission"
  | "slow"
  | "slower"
  | "controls"
  | "echo"
  | "plan-writer"
  | "file-writer"
  | "question"
  | "interview"
  | "journey"
  | "exec-streamer"
  | "typed-record";

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

/** typed-record only: first plan attempt is non-conforming, retried on rejection. */
const flakyPlan = process.argv.includes("--flaky-plan");

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

/** A `let`, because `session/set_config_option` persists the change — a second call must see the
 * first one's value, exactly as a real agent's would. */
let configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "sonnet",
    options: [
      { value: "sonnet", name: "Sonnet" },
      { value: "opus", name: "Opus" },
    ],
  },
  {
    id: "thought_level",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: "think",
    options: [
      { value: "think", name: "Think" },
      { value: "think_hard", name: "Think hard" },
    ],
  },
  // RQ-0042's real two-MODE collision: the harness's own option lands on the same word as the ACP
  // session mode control. `id` is deliberately not "mode" — that id is already the session control's
  // own chip testid, and colliding on it would break the popover rather than exercise it.
  {
    id: "style",
    name: "Mode",
    category: "style",
    type: "select",
    currentValue: "auto",
    options: [
      { value: "auto", name: "Auto" },
      { value: "manual", name: "Manual" },
    ],
  },
  // The spec's own example of a config option is a permission-mode selector; this is the entry the
  // supervision mapping targets (RQ-0050 / ST-0067).
  {
    id: "permission_mode",
    name: "Permission mode",
    category: "permission",
    type: "select",
    currentValue: "ask",
    options: [
      { value: "ask", name: "Ask" },
      { value: "auto", name: "Auto" },
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

/** The next free number for a prefix, by scanning a bundle directory the way minting does. */
function nextNumber(dir: string, prefix: string): number {
  if (!existsSync(dir)) return 1;
  const taken = readdirSync(dir)
    .map((name) => new RegExp(`^${prefix}-(\\d+)\\.md$`).exec(name))
    .flatMap((match) => (match === null ? [] : [Number(match[1])]));
  return taken.length === 0 ? 1 : Math.max(...taken) + 1;
}

const pad = (n: number): string => String(n).padStart(4, "0");

/**
 * A scripted planning turn: one draft Story and one draft TestCase per requirement id named in the
 * prompt, written straight into the project's record with their index rows — which is exactly what
 * the plan playbook asks a real agent to do, minus the judgement. The e2e asserts the application's
 * half: gathering, shaping, approving. Deterministic on purpose; `created` is fixed, not today.
 */
function planWriterTurn(prompt: string): string {
  const cwd = process.cwd();
  const picked = [...new Set(prompt.toUpperCase().match(/RQ-\d{4,}/g) ?? [])];
  const stories = join(cwd, "docs", "user-stories");
  const tests = join(cwd, "docs", "testing");
  mkdirSync(stories, { recursive: true });
  mkdirSync(tests, { recursive: true });

  let storyNumber = nextNumber(stories, "st");
  let testNumber = nextNumber(tests, "tc");

  for (const requirement of picked) {
    const storyId = `ST-${pad(storyNumber)}`;
    const testId = `TC-${pad(testNumber)}`;
    const storyFile = join(stories, `${storyId.toLowerCase()}.md`);
    const testFile = join(tests, `${testId.toLowerCase()}.md`);

    writeFileSync(
      storyFile,
      `---\ntype: Story\nid: ${storyId}\ntitle: "Deliver ${requirement}"\nstate: draft\nowner: stub\nprovenance: agent\ncreated: 2026-08-20\ngenerated: { by: "stub-acp-agent", at: 2026-08-20T00:00:00Z }\nlinks:\n  implements: [${requirement}]\n  verified_by: [${testId}]\n---\n\n# ${storyId} — Deliver ${requirement}\n\nA scripted slice for ${requirement}.\n\n## Acceptance criteria\n\n- [AC-1] The behaviour ${requirement} asks for is observable.\n`,
    );
    writeFileSync(
      testFile,
      `---\ntype: TestCase\nid: ${testId}\ntitle: "${requirement} behaves as asked"\nstate: draft\nowner: stub\nprovenance: agent\ncreated: 2026-08-20\ngenerated: { by: "stub-acp-agent", at: 2026-08-20T00:00:00Z }\nkind: automated\nlinks:\n  verifies: [${requirement}]\n---\n\n# ${testId} — ${requirement} behaves as asked\n\n## Steps\n\n1. Exercise ${requirement} and expect what it promises.\n`,
    );
    appendFileSync(
      join(stories, "README.md"),
      `| [${storyId}](${storyId.toLowerCase()}.md) | Deliver ${requirement} | draft | [${requirement}](../requirements/${requirement.toLowerCase()}.md) · [${testId}](../testing/${testId.toLowerCase()}.md) |\n`,
    );
    appendFileSync(
      join(tests, "README.md"),
      `| [${testId}](${testId.toLowerCase()}.md) | ${requirement} behaves as asked | draft | [${requirement}](../requirements/${requirement.toLowerCase()}.md) |\n`,
    );

    update({
      sessionUpdate: "tool_call",
      toolCallId: `write-${storyId}`,
      title: `Write ${storyId} and ${testId}`,
      kind: "edit",
      status: "completed",
      locations: [{ path: storyFile }, { path: testFile }],
    });
    storyNumber += 1;
    testNumber += 1;
  }

  chunk(
    picked.length === 0
      ? "No requirement ids in the prompt."
      : `Proposed ${picked.length} draft stories.`,
  );
  return "end_turn";
}

/** One fenced question, exactly as DC-0020's convention writes it. */
const fencedQuestion = (question: string, options: [string, string][]): string =>
  `\`\`\`aibuildos-question\n${JSON.stringify({
    question,
    options: options.map(([id, label]) => ({ id, label })),
    allowFreeText: true,
  })}\n\`\`\``;

/** Odd prompts ask; even prompts echo the answer that came back. */
let questionTurns = 0;
function questionTurn(prompt: string): string {
  questionTurns += 1;
  if (questionTurns % 2 === 1) {
    chunk(
      `A quick question first.\n\n${fencedQuestion("Which colour?", [
        ["red", "Red"],
        ["blue", "Blue"],
      ])}`,
    );
  } else {
    chunk(`You answered: ${prompt}`);
  }
  return "end_turn";
}

/**
 * The scripted interview: two questions, then one draft requirement written into the record with
 * its index row — the shape the intake playbook asks a real agent to produce, minus the judgement.
 */
let interviewTurns = 0;
function interviewTurn(): string {
  interviewTurns += 1;
  if (interviewTurns === 1) {
    chunk(
      fencedQuestion("Who is this for?", [
        ["me", "Just me"],
        ["team", "My team"],
      ]),
    );
    return "end_turn";
  }
  if (interviewTurns === 2) {
    chunk(
      fencedQuestion("What must work first?", [
        ["save", "Saving"],
        ["share", "Sharing"],
      ]),
    );
    return "end_turn";
  }

  const cwd = process.cwd();
  const dir = join(cwd, "docs", "requirements");
  mkdirSync(dir, { recursive: true });
  const id = `RQ-${pad(nextNumber(dir, "rq"))}`;
  writeFileSync(
    join(dir, `${id.toLowerCase()}.md`),
    `---\ntype: Requirement\nid: ${id}\ntitle: "What the interview settled"\nstate: draft\nowner: stub\nprovenance: agent\ncreated: 2026-08-20\ngenerated: { by: "stub-acp-agent", at: 2026-08-20T00:00:00Z }\nkind: functional\n---\n\n# ${id} — What the interview settled\n\n## Acceptance criteria\n\n- [AC-1] The settled behaviour is observable.\n`,
  );
  appendFileSync(
    join(dir, "README.md"),
    `| [${id}](${id.toLowerCase()}.md) | What the interview settled | draft | — |\n`,
  );
  update({
    sessionUpdate: "tool_call",
    toolCallId: `intake-${id}`,
    title: `Write ${id}`,
    kind: "edit",
    status: "completed",
    locations: [{ path: join(dir, `${id.toLowerCase()}.md`) }],
  });
  chunk(`Added ${id} to the list.`);
  return "end_turn";
}

/** How many prompts the journey has seen: the first plans, the rest build. */
let journeyTurns = 0;

/** How many prompts controls mode has seen — what its command re-advertisement is keyed on. */
let controlsTurns = 0;

/**
 * One execute tool call whose output arrives in streamed chunks (RQ-0031): the command in the
 * call's raw input, four content updates spaced out enough for a test to observe streaming, a
 * completed result carrying the raw output — the exact wire shape a terminal card must read.
 */
async function execStreamerTurn(): Promise<string> {
  update({
    sessionUpdate: "tool_call",
    toolCallId: "exec-1",
    title: "Run the tests",
    kind: "execute",
    status: "in_progress",
    rawInput: { command: "bun run test" },
  });
  const chunks = ["line one\n", "line two\n", "line three\n", "line four\n"];
  for (const [index, text] of chunks.entries()) {
    await sleep(120);
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "exec-1",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text } }],
    });
    if (index === 1 && cancelled) break;
  }
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "exec-1",
    status: "completed",
    rawOutput: { exitCode: 0, output: chunks.join("") },
  });
  chunk("Ran the tests.");
  return "end_turn";
}

/**
 * The typed-record turn (RQ-0052, DC-0028): the same scripted content plan-writer writes as files,
 * sent instead as data over the extension's own wire. A "run the checks" prompt reports a typed
 * verdict for the TestCase the prompt names; anything else with requirement ids in it proposes a
 * plan and narrates what came back — including the reject-and-retry `--flaky-plan` provokes.
 */
let planAttempts = 0;

function typedPlanPayload(picked: string[]): unknown {
  planAttempts += 1;
  return {
    sessionId: SESSION,
    // `_meta` rides the payload so the client's forwarding of it is provable end to end.
    _meta: { "aibuildos/typed-record": { attempt: planAttempts } },
    stories: picked.map((requirement) => ({
      title: `Deliver ${requirement}`,
      implements: [requirement],
      criteria: [`The behaviour ${requirement} asks for is observable.`],
    })),
    testCases: picked.map((requirement) => ({
      title: `${requirement} behaves as asked`,
      kind: "automated",
      verifies: [requirement],
      steps: [`Exercise ${requirement} and expect what it promises.`],
    })),
  };
}

async function typedRecordTurn(prompt: string): Promise<string> {
  const testCase = /TC-\d{4,}/i.exec(prompt)?.[0]?.toUpperCase();
  if (/run the checks/i.test(prompt) && testCase !== undefined) {
    const result = /fail/i.test(prompt) ? "failed" : "passed";
    write({
      jsonrpc: "2.0",
      method: "_aibuildos/verdict",
      params: { sessionId: SESSION, testCaseId: testCase, result, ranAt: "2026-08-20T00:00:00Z" },
    });
    chunk(`Reported ${result} for ${testCase}.`);
    return "end_turn";
  }

  const picked = [...new Set(prompt.toUpperCase().match(/RQ-\d{4,}/g) ?? [])];
  if (picked.length === 0) {
    chunk("No requirement ids in the prompt.");
    return "end_turn";
  }

  let payload = typedPlanPayload(picked);
  if (flakyPlan && planAttempts === 1) {
    // Non-conforming on purpose: an empty title fails the client's schema, and the findings that
    // come back are what prompt the conforming retry below.
    const first = (payload as { stories: { title: string }[] }).stories[0];
    if (first) first.title = "";
  }
  let answer = (await callClient("_aibuildos/plan", payload)) as {
    accepted?: boolean;
    ids?: string[];
  };
  if (answer?.accepted !== true && flakyPlan) {
    chunk("Plan rejected; retrying.");
    payload = typedPlanPayload(picked);
    answer = (await callClient("_aibuildos/plan", payload)) as typeof answer;
  }
  chunk(
    answer?.accepted === true
      ? `Proposed ${picked.length} typed stories.`
      : "The plan was rejected.",
  );
  return "end_turn";
}

/** One scripted file change per turn — the smallest thing a build produces. */
let buildTurns = 0;
function fileWriterTurn(): string {
  const file = join(process.cwd(), "notes.md");
  buildTurns += 1;
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = `built: turn ${buildTurns}\n`;
  writeFileSync(file, before + line);

  update({
    sessionUpdate: "tool_call",
    toolCallId: `build-${buildTurns}`,
    title: "Edit notes.md",
    kind: "edit",
    status: "completed",
    content: [{ type: "diff", path: file, oldText: before, newText: before + line }],
  });
  chunk(`Changed notes.md (turn ${buildTurns}).`);
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
async function slowTurn(delayMs = 25): Promise<string> {
  for (let index = 0; index < 20; index += 1) {
    if (cancelled) {
      update({ sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "failed" });
      chunk(" [stopped]", "message-1");
      return "cancelled";
    }
    chunk(`${index} `, "message-1");
    await sleep(delayMs);
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
        // Extension support is advertised in the capability object's `_meta`, per the spec
        // (DC-0028). Every other mode advertises nothing — the baseline negative control.
        agentCapabilities:
          mode === "typed-record" ? { _meta: { "aibuildos/typed-record": { version: 1 } } } : {},
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
        ...(mode === "controls" ? { modes: MODES, configOptions } : {}),
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
      const params = message.params as { configId?: string; value?: string };
      // Persisted, not just echoed: mapping over the list and forgetting the result was a real
      // stub bug — a second change would silently revert the first on the wire.
      configOptions = configOptions.map((option) =>
        option.id === params?.configId
          ? { ...option, currentValue: params?.value ?? option.currentValue }
          : option,
      );
      respond(message.id, { configOptions });
      update({ sessionUpdate: "config_option_update", configOptions });
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
      // Long enough that a spec can edit, assert, and close *under* the stream on a slow CI runner.
      else if (mode === "slower") stopReason = await slowTurn(300);
      else if (mode === "echo" || mode === "controls") {
        // The prompt is content blocks; echoing the text back proves on the transcript both what
        // was sent and what arrived — which is what a playbook test needs and a mock cannot give.
        // Controls mode echoes too, so a command's exact wire text is provable (ST-0069).
        const blocks = (message.params as { prompt?: { type?: string; text?: string }[] })?.prompt;
        chunk((blocks ?? []).map((block) => block.text ?? "").join(""));
        if (mode === "controls") {
          // A real agent re-advertises as its command set moves (ST-0069): the first turn gains
          // one, the second withdraws the original — the client must replace, never merge.
          controlsTurns += 1;
          if (controlsTurns === 1) {
            update({
              sessionUpdate: "available_commands_update",
              availableCommands: [
                { name: "review", description: "Review the working tree" },
                { name: "ship", description: "Ship the change" },
              ],
            });
          } else if (controlsTurns === 2) {
            update({
              sessionUpdate: "available_commands_update",
              availableCommands: [{ name: "ship", description: "Ship the change" }],
            });
          }
        }
      } else if (
        mode === "plan-writer" ||
        mode === "file-writer" ||
        mode === "question" ||
        mode === "interview" ||
        mode === "journey" ||
        mode === "exec-streamer" ||
        mode === "typed-record"
      ) {
        const blocks = (message.params as { prompt?: { type?: string; text?: string }[] })?.prompt;
        const text = (blocks ?? []).map((block) => block.text ?? "").join("");
        journeyTurns += 1;
        stopReason =
          mode === "plan-writer"
            ? planWriterTurn(text)
            : mode === "file-writer"
              ? fileWriterTurn()
              : mode === "question"
                ? questionTurn(text)
                : mode === "interview"
                  ? interviewTurn()
                  : mode === "exec-streamer"
                    ? await execStreamerTurn()
                    : mode === "typed-record"
                      ? await typedRecordTurn(text)
                      : journeyTurns === 1
                        ? planWriterTurn(text)
                        : fileWriterTurn();
      } else chunk("ok");

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

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HARNESS_PRESETS } from "@aibuildos/acp";
import { CUSTOM } from "@aibuildos/acp/bridge";
import type { EventPayload } from "@aibuildos/ipc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Harness, loadHarnesses, saveHarness } from "./harnesses.js";
import { BUSY_CAP, SessionRegistry, type SupervisionLevel } from "./sessions.js";

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

/**
 * TC-0101. `busyCount()` — busy means `storyId ≠ null` or `label ≠ null` — is the single check
 * `build:start` and background `session:start` both consult, `BUSY_CAP` living beside it.
 */
describe("the concurrency cap", () => {
  let cwd: string;
  let registry: SessionRegistry;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "aibuildos-sessions-cap-"));
    registry = new SessionRegistry(
      () => {},
      () => "closest",
    );
  });

  afterEach(async () => {
    await registry.closeAll();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const startSession = async (storyId: string | null, label: string | null) => {
    const result = await registry.start(harness, "project-1", cwd, "1.0.0", storyId, label);
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.sessionId;
  };

  it("counts builds and background runs together, and never a plain chat, toward the cap", async () => {
    const build1 = await startSession("story-1", null);
    const build2 = await startSession("story-2", null);
    const background = await startSession(null, "Draft requirements");

    // Three busy sessions of any mix — whichever door a fourth start knocks on, both
    // `build:start` and background `session:start` read this same number and refuse.
    expect(registry.busyCount()).toBe(BUSY_CAP);

    // Plain chat sessions carry neither field and spend nothing from the cap.
    const chat1 = await startSession(null, null);
    const chat2 = await startSession(null, null);
    expect(registry.busyCount()).toBe(BUSY_CAP);

    // Ending one busy session frees a slot for the next start.
    await registry.close(build1);
    expect(registry.busyCount()).toBe(BUSY_CAP - 1);

    await registry.close(build2);
    await registry.close(background);
    await registry.close(chat1);
    await registry.close(chat2);
  });
});

/**
 * TC-0103. Every `session:list` row carries `label` and `startedAt`, and kind is derived from
 * `storyId`/`label` alone — never stored.
 */
describe("session inventory rows", () => {
  let cwd: string;
  let registry: SessionRegistry;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "aibuildos-sessions-rows-"));
    registry = new SessionRegistry(
      () => {},
      () => "closest",
    );
  });

  afterEach(async () => {
    await registry.closeAll();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("carries label and startedAt on a build, a background run and a chat alike, kind derived not stored", async () => {
    const build = await registry.start(harness, "project-1", cwd, "1.0.0", "story-1", null);
    const background = await registry.start(
      harness,
      "project-1",
      cwd,
      "1.0.0",
      null,
      "Draft requirements",
    );
    const chat = await registry.start(harness, "project-1", cwd, "1.0.0");
    if (!build.ok || !background.ok || !chat.ok) throw new Error("expected all three to open");

    const rows = registry.list();
    const byId = new Map(rows.map((row) => [row.sessionId, row]));
    const buildRow = byId.get(build.sessionId);
    const backgroundRow = byId.get(background.sessionId);
    const chatRow = byId.get(chat.sessionId);
    if (!buildRow || !backgroundRow || !chatRow) throw new Error("expected all three rows");

    for (const row of [buildRow, backgroundRow, chatRow]) {
      expect(new Date(row.startedAt).toISOString()).toBe(row.startedAt);
      // No stored kind field anywhere — the row shape itself is the proof.
      expect(row).not.toHaveProperty("kind");
    }

    // storyId set reads as build, label set as task, neither as chat.
    expect(buildRow.storyId).toBe("story-1");
    expect(buildRow.label).toBeNull();
    expect(backgroundRow.storyId).toBeNull();
    expect(backgroundRow.label).toBe("Draft requirements");
    expect(chatRow.storyId).toBeNull();
    expect(chatRow.label).toBeNull();

    await registry.close(build.sessionId);
    await registry.close(background.sessionId);
    await registry.close(chat.sessionId);
  });
});

/**
 * TC-0119 (RQ-0050#AC-1, AC-2). The supervision mapping as the registry actually uses it: applied at
 * session start, fanned out to every open session of one project when the level changes, and read
 * only ever as `harness.supervisionOptions?.[level]` — so the same stub proves both a mapped harness
 * and an unmapped one with no branch in the registry naming either.
 *
 * `--mode=controls`, because it is the only stub mode that advertises config options at all; the
 * `permission_mode` entry it offers is the spec's own example of a permission-flavoured one.
 */
const CONTROLS = ["--experimental-strip-types", stub, "--mode=controls"];

const mapped: Harness = {
  id: "stub-mapped",
  displayName: "Stub",
  command: process.execPath,
  args: CONTROLS,
  supervisionOptions: {
    closest: { configId: "permission_mode", value: "ask" },
    "hands-off": { configId: "permission_mode", value: "auto" },
  },
};

const unmapped: Harness = {
  id: "stub-unmapped",
  displayName: "Stub",
  command: process.execPath,
  args: CONTROLS,
};

describe("the supervision mapping", () => {
  let cwd: string;
  let registry: SessionRegistry;
  let level: SupervisionLevel;
  /** Every `acp.config_options` the agents announced, in order, with the session that said it. */
  let announced: { sessionId: string; permissionMode: string | undefined }[];
  /** The registry's own narration when a mapped option is not on offer. */
  let notes: { sessionId: string; message: string }[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "aibuildos-supervision-"));
    level = "closest";
    announced = [];
    notes = [];
    registry = new SessionRegistry(
      (event, payload) => {
        if (event !== "session:event") return;
        const { sessionId, event: inner } = payload as EventPayload<"session:event">;
        const { name, value } = inner as unknown as { name?: string; value?: unknown };
        if (name === CUSTOM.configOptions) {
          const options = (value as { configOptions?: { id: string; currentValue?: string }[] })
            ?.configOptions;
          announced.push({
            sessionId,
            permissionMode: options?.find((option) => option.id === "permission_mode")
              ?.currentValue,
          });
        }
        if (name === "aibuildos.supervision") {
          notes.push({ sessionId, message: (value as { message: string }).message });
        }
      },
      () => level,
    );
  });

  afterEach(async () => {
    await registry.closeAll();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const open = async (harness: Harness, projectId: string): Promise<string> => {
    const result = await registry.start(harness, projectId, cwd, "1.0.0");
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
    return result.sessionId;
  };

  it("sends the level's mapped option to the agent as the session starts", async () => {
    level = "hands-off";
    const sessionId = await open(mapped, "project-1");

    // The stub wakes at "ask" and persists what it is told, so "auto" can only have come from the
    // level being applied over the real wire.
    await waitFor(() => announced.length === 1);
    expect(announced[0]).toEqual({ sessionId, permissionMode: "auto" });
  });

  it("fans a level change out to every open session of that project, and to no other's", async () => {
    const first = await open(mapped, "project-1");
    const second = await open(mapped, "project-1");
    const other = await open(mapped, "project-2");
    await waitFor(() => announced.length === 3); // each start applied "closest" — "ask"
    announced = [];

    await registry.applySupervision("project-1", "hands-off");
    await waitFor(() => announced.length === 2);

    expect(announced.map((entry) => entry.permissionMode)).toEqual(["auto", "auto"]);
    expect(new Set(announced.map((entry) => entry.sessionId))).toEqual(new Set([first, second]));
    expect(announced.some((entry) => entry.sessionId === other)).toBe(false);
  });

  it("sends nothing at all for a harness that maps nothing", async () => {
    const sessionId = await open(unmapped, "project-1");

    // A round trip on the same pipe: anything the stub had queued to say arrives before this
    // resolves, so an empty list afterwards is an absence rather than a race.
    await registry.prompt(sessionId, "ping");

    expect(announced).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("narrates a mapped option the agent never advertised instead of failing the session", async () => {
    // `--mode=permission` offers no config options — the same mapped record, an agent that cannot
    // take it.
    level = "hands-off";
    const sessionId = await open({ ...mapped, args: harness.args }, "project-1");

    expect(announced).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.sessionId).toBe(sessionId);
    expect(notes[0]?.message).toContain("permission_mode");

    // And the level still does everything it did before RQ-0050 existed: this turn's permission
    // request is answered hands-off, on this side, with nothing having reached the agent.
    expect(await registry.prompt(sessionId, "run the tests")).toEqual({ stopReason: "end_turn" });
  });

  it("round-trips the mapping through the harness record, prefilled from the shipped presets", () => {
    const file = join(cwd, "harnesses.json");
    const preset = HARNESS_PRESETS.find((candidate) => candidate.id === "claude-code");
    if (preset?.supervisionOptions === undefined) throw new Error("expected a mapped preset");

    // Saved the way the form saves it: no id, so one is minted. That minted id is precisely why the
    // mapping has to live on the record — nothing downstream could find the preset again.
    const saved = saveHarness(file, {
      displayName: preset.displayName,
      command: preset.command,
      args: [...preset.args],
      supervisionOptions: preset.supervisionOptions,
    });
    expect(saved.id).not.toBe(preset.id);

    expect(loadHarnesses(file)[0]?.supervisionOptions).toEqual(preset.supervisionOptions);
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseEvent } from "@ag-ui/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CUSTOM } from "./bridge.js";
import {
  AgentSession,
  type PermissionRequest,
  SessionError,
  TYPED_RECORD,
} from "./session.js";

/**
 * TC-0015 and TC-0017. A session that stays open, streams everything, cancels cleanly, and asks.
 *
 * Against the scripted stub, never a live model (DC-0013) — which is why the stub grew the update
 * kinds, the permission round trip and the cancel path these cases need.
 */
const stub = fileURLToPath(new URL("../../../tools/stub-acp-agent/src/agent.ts", import.meta.url));

/** `engines` admits Node 22.0, where stripping types is not yet the default. */
const spec = (mode?: string) => ({
  command: process.execPath,
  args: ["--experimental-strip-types", stub, ...(mode ? [`--mode=${mode}`] : [])],
});

const named = (events: BaseEvent[], name: string): BaseEvent[] =>
  events.filter((event) => (event as unknown as { name?: string }).name === name);

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

describe("a live agent session", () => {
  let cwd: string;
  let events: BaseEvent[];
  let open: AgentSession[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "aibuildos-session-"));
    events = [];
    open = [];
  });

  afterEach(async () => {
    for (const session of open) await session.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const start = async (
    mode?: string,
    extra: Partial<{ onPermission: (r: PermissionRequest) => Promise<string | null> }> = {},
  ) => {
    const session = await AgentSession.open(spec(mode), {
      cwd,
      onEvent: (event) => events.push(event),
      ...extra,
    });
    open.push(session);
    return session;
  };

  it("opens, and answers a second prompt without respawning the agent", async () => {
    const session = await start();
    expect(session.sessionId).toBe("stub-session");

    expect(await session.prompt("one")).toBe("end_turn");
    const afterFirst = events.length;

    // The same session, still open. A fresh spawn would produce a different session id.
    expect(await session.prompt("two")).toBe("end_turn");
    expect(session.sessionId).toBe("stub-session");
    expect(events.length).toBeGreaterThan(afterFirst);
  });

  it("delivers every kind of update, not only the message text", async () => {
    const session = await start("rich");
    await session.prompt("do the thing");

    // The probe keeps the text and throws these away; a conversation cannot.
    expect(named(events, CUSTOM.plan).length).toBeGreaterThanOrEqual(2);
    expect(named(events, CUSTOM.usage)).toHaveLength(1);
    // A tool call travels on AG-UI's own tool channel so the transcript can draw it in place.
    expect(events.filter((e) => e.type === "TOOL_CALL_START")).toHaveLength(1);
    expect(events.filter((e) => e.type === "TOOL_CALL_RESULT")).toHaveLength(1);

    const reasoning = events.filter((e) => e.type === "REASONING_MESSAGE_CONTENT");
    const text = events.filter((e) => e.type === "TEXT_MESSAGE_CONTENT");
    expect(reasoning.length).toBeGreaterThan(0);
    expect(text.length).toBe(2);
  });

  it("carries a diff with both sides intact", async () => {
    const session = await start("rich");
    await session.prompt("edit it");

    const [result] = events.filter((event) => event.type === "TOOL_CALL_RESULT");
    const value = JSON.parse((result as unknown as { content: string }).content) as {
      content: { path: string; newText: string }[];
    };

    expect(value.content[0]?.path).toMatch(/ui\.ts$/);
    expect(value.content[0]?.newText).toContain("gap = 4");
  });

  it("cancels a turn without reporting it as a failure", async () => {
    const session = await start("slow");

    const turn = session.prompt("count slowly");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await session.cancel();

    // The protocol requires the client to keep accepting updates after cancelling, so the turn
    // resolves on the agent's own terms rather than being torn down.
    expect(await turn).toBe("cancelled");

    const finished = events.filter((e) => e.type === "RUN_FINISHED");
    expect(finished).toHaveLength(1);
    expect(events.filter((e) => e.type === "RUN_ERROR")).toHaveLength(0);
    expect((finished[0] as unknown as { result: { stopReason: string } }).result.stopReason).toBe(
      "cancelled",
    );
  });

  it("keeps delivering the updates that arrive after a cancel", async () => {
    const session = await start("slow");
    const turn = session.prompt("count slowly");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await session.cancel();
    await turn;

    // The stub sends these *after* it sees the cancel; dropping them would lose the agent's last word.
    expect(events.filter((event) => event.type === "TOOL_CALL_RESULT")).toHaveLength(1);
    const text = events
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => (e as unknown as { delta: string }).delta)
      .join("");
    expect(text).toContain("[stopped]");
  });

  it("reports a command that is not there, rather than blaming the working directory", async () => {
    await expect(
      AgentSession.open(
        { command: "definitely-not-a-real-agent", args: [] },
        { cwd, onEvent: () => {} },
      ),
    ).rejects.toMatchObject({ code: "command_not_found" });
  });

  it("reports a working directory that is not there", async () => {
    await expect(
      AgentSession.open(spec(), { cwd: join(cwd, "nope"), onEvent: () => {} }),
    ).rejects.toMatchObject({ code: "cwd_not_found" });
  });

  it.skipIf(process.platform === "win32")(
    "reaps the agent and everything it spawned when the session closes",
    async () => {
      // The shipped presets are all `npx -y <pkg>`, so the agent is a grandchild of the process this
      // holds. `sh -c` reproduces that shape offline: a marker process in the background, the stub
      // `exec`d in the foreground so the session really opens.
      const marker = "aibuildos-orphan-session";
      const session = await AgentSession.open(
        {
          command: "/bin/sh",
          args: [
            "-c",
            `${process.execPath} -e 'setTimeout(()=>{},30000)' ${marker} & ` +
              `exec ${process.execPath} --experimental-strip-types ${stub}`,
          ],
        },
        { cwd, onEvent: (event) => events.push(event) },
      );
      expect(await session.prompt("hello")).toBe("end_turn");

      await session.close();
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(survivorsOf(marker)).toBe("");
    },
  );

  it("refuses to prompt a session that has been closed", async () => {
    const session = await start();
    await session.close();

    await expect(session.prompt("hello")).rejects.toBeInstanceOf(SessionError);
  });
});

describe("what the agent asks and what it offers", () => {
  let cwd: string;
  let events: BaseEvent[];
  let open: AgentSession[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "aibuildos-session-"));
    events = [];
    open = [];
  });

  afterEach(async () => {
    for (const session of open) await session.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const start = async (
    mode: string,
    onPermission?: (r: PermissionRequest) => Promise<string | null>,
  ) => {
    const session = await AgentSession.open(
      { command: process.execPath, args: ["--experimental-strip-types", stub, `--mode=${mode}`] },
      { cwd, onEvent: (event) => events.push(event), ...(onPermission ? { onPermission } : {}) },
    );
    open.push(session);
    return session;
  };

  it("asks with the agent's own options, and obeys the answer", async () => {
    let asked: PermissionRequest | null = null;

    const session = await start("permission", async (request) => {
      asked = request;
      return "allow-once";
    });
    await session.prompt("run the tests");

    expect(asked).not.toBeNull();
    // Exactly the options the stub sent, in the stub's wording. Nothing invented.
    expect((asked as unknown as PermissionRequest).options.map((o) => o.optionId)).toEqual([
      "allow-once",
      "allow-always",
      "reject",
    ]);
    expect((asked as unknown as PermissionRequest).options.map((o) => o.name)).toEqual([
      "Allow once",
      "Allow always",
      "Reject",
    ]);

    const text = events
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => (e as unknown as { delta: string }).delta)
      .join("");
    expect(text).toContain("Tests passed");
  });

  it("carries a refusal through to the agent", async () => {
    const session = await start("permission", async () => "reject");
    await session.prompt("run the tests");

    const text = events
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => (e as unknown as { delta: string }).delta)
      .join("");
    expect(text).toContain("did not run it");
  });

  it("declines when nobody is there to answer", async () => {
    // No `onPermission`. An agent proceeding because nobody was listening is the one outcome this
    // must never produce.
    const session = await start("permission");
    expect(await session.prompt("run the tests")).toBe("cancelled");
  });

  it("reports what the agent offers, and reports nothing when it offers nothing", async () => {
    const offering = await start("controls");
    expect(offering.offered.modes?.availableModes.map((m) => m.id)).toEqual(["plan", "code"]);
    expect(offering.offered.configOptions?.map((o) => o.id)).toEqual([
      "model",
      "thought_level",
      "style",
      "permission_mode",
    ]);

    const silent = await start("rich");
    // Absent, not an empty set of choices — the difference the design turns on.
    expect(silent.offered.modes ?? null).toBeNull();
    expect(silent.offered.configOptions ?? null).toBeNull();
  });

  it("reports an agent that will not start until it is logged in, with its own methods", async () => {
    await expect(
      AgentSession.open(
        {
          command: process.execPath,
          args: ["--experimental-strip-types", stub, "--mode=auth-required"],
        },
        { cwd, onEvent: () => {} },
      ),
    ).rejects.toMatchObject({
      code: "auth_required",
      authMethods: [{ id: "stub-login", name: "Log in to the stub" }],
    });
  });

  it("passes the commands the agent advertises straight through", async () => {
    const session = await start("controls");
    await session.prompt("hello");

    const [commands] = named(events, CUSTOM.commands);
    const value = (commands as unknown as { value: { availableCommands: { name: string }[] } })
      .value;
    expect(value.availableCommands.map((c) => c.name)).toEqual(["review"]);
  });
});

describe("the typed-record extension (RQ-0052, DC-0028)", () => {
  let cwd: string;
  let events: BaseEvent[];
  let open: AgentSession[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "aibuildos-session-"));
    events = [];
    open = [];
  });

  afterEach(async () => {
    for (const session of open) await session.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const start = async (
    args: string[],
    extra: Partial<{
      onPlan: (payload: unknown) => Promise<unknown>;
      onVerdict: (payload: unknown) => void;
    }> = {},
  ) => {
    const session = await AgentSession.open(
      { command: process.execPath, args: ["--experimental-strip-types", stub, ...args] },
      { cwd, onEvent: (event) => events.push(event), ...extra },
    );
    open.push(session);
    return session;
  };

  const transcript = (): string =>
    events
      .filter((e) => e.type === "TEXT_MESSAGE_CONTENT")
      .map((e) => (e as unknown as { delta: string }).delta)
      .join("");

  it("retains what initialize advertised, and an agent advertising nothing answers null", async () => {
    const advertising = await start(["--mode=typed-record"]);
    expect(advertising.extension(TYPED_RECORD)).toEqual({ version: 1 });

    // The baseline negative control (RQ-0052#AC-4): every other mode advertises nothing, and
    // absent is the answer — not an empty object to be mistaken for support.
    const baseline = await start([]);
    expect(baseline.extension(TYPED_RECORD)).toBeNull();
    expect(baseline.extension("aibuildos/some-other-extension")).toBeNull();
  });

  it("carries a typed plan to the handler and the handler's answer back, payload whole", async () => {
    const proposals: unknown[] = [];
    const session = await start(["--mode=typed-record"], {
      onPlan: async (payload) => {
        proposals.push(payload);
        return { accepted: true, ids: ["ST-0001", "TC-0001"] };
      },
    });
    await session.prompt("Plan RQ-0001 please");

    // The handler saw the agent's payload as data — including `_meta`, which the known update
    // kinds strip and an extension payload must keep.
    expect(proposals).toHaveLength(1);
    const payload = proposals[0] as {
      _meta: Record<string, unknown>;
      stories: { implements: string[] }[];
    };
    expect(payload.stories[0]?.implements).toEqual(["RQ-0001"]);
    expect(payload._meta).toEqual({ [TYPED_RECORD]: { attempt: 1 } });

    // The same payload rode the bridge as a CUSTOM event, whole (TC-0121) — no new door.
    const [proposal] = named(events, CUSTOM.planProposal);
    const value = (proposal as unknown as { value: { payload: unknown; response: unknown } })
      .value;
    expect(value.payload).toEqual(payload);
    expect(value.response).toEqual({ accepted: true, ids: ["ST-0001", "TC-0001"] });

    // And the agent acted on the acceptance it was handed back.
    expect(transcript()).toContain("Proposed 1 typed stories.");
  });

  it("rejects back with findings, and the agent retries conforming", async () => {
    const proposals: { title: string }[] = [];
    const session = await start(["--mode=typed-record", "--flaky-plan"], {
      onPlan: async (payload) => {
        const first = (payload as { stories: { title: string }[] }).stories[0];
        if (first) proposals.push(first);
        return first?.title === ""
          ? {
              accepted: false,
              findings: [{ rule: "plan/schema", severity: "error", message: "title is empty" }],
            }
          : { accepted: true, ids: ["ST-0001", "TC-0001"] };
      },
    });
    await session.prompt("Plan RQ-0001 please");

    // Two proposals: the non-conforming one, then the retry the findings prompted (RQ-0052#AC-1).
    expect(proposals.map((story) => story.title)).toEqual(["", "Deliver RQ-0001"]);
    expect(named(events, CUSTOM.planProposal)).toHaveLength(2);
    expect(transcript()).toContain("Plan rejected; retrying.");
    expect(transcript()).toContain("Proposed 1 typed stories.");
  });

  it("refuses a plan when nobody is wired to accept one", async () => {
    // No `onPlan`: the agent still gets an answer it can act on, not a protocol error.
    const session = await start(["--mode=typed-record"]);
    await session.prompt("Plan RQ-0001 please");
    expect(transcript()).toContain("The plan was rejected.");
  });

  it("delivers a typed verdict, forwarded whole as an event", async () => {
    const verdicts: unknown[] = [];
    const session = await start(["--mode=typed-record"], {
      onVerdict: (payload) => verdicts.push(payload),
    });
    await session.prompt("run the checks for TC-0031");

    expect(verdicts).toEqual([
      {
        sessionId: "stub-session",
        testCaseId: "TC-0031",
        result: "passed",
        ranAt: "2026-08-20T00:00:00Z",
      },
    ]);
    const [verdict] = named(events, CUSTOM.checkVerdict);
    expect((verdict as unknown as { value: unknown }).value).toEqual(verdicts[0]);
    expect(transcript()).toContain("Reported passed for TC-0031.");
  });
});

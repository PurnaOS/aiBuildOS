import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { SessionBridge } from "@aibuildos/acp/bridge";
import { describe, expect, it } from "vitest";
import { commandsIn, getCommands, setCommands, subscribeCommands } from "./commands.js";

/**
 * RQ-0051#AC-3: the list is alive and it is replaced whole.
 *
 * Driven by events the real bridge produces, the way `toolCall.test.ts` does — so this proves the
 * store reads what the wire actually sends rather than a hand-rolled guess at its shape. The store's
 * `Map` is module-level and outlives each test, so every test uses its own session id rather than a
 * reset nothing in the application would ever call.
 */
function wire(update: SessionUpdate): { type: string; name?: string; value?: unknown }[] {
  return new SessionBridge("thread-1").update(update) as unknown as {
    type: string;
    name?: string;
    value?: unknown;
  }[];
}

function advertise(names: string[]): { type: string; name?: string; value?: unknown }[] {
  return wire({
    sessionUpdate: "available_commands_update",
    availableCommands: names.map((name) => ({ name, description: `the ${name} command` })),
  } as SessionUpdate);
}

describe("reading an advertisement off the wire", () => {
  it("takes the harness's list from the bridge's own CUSTOM event", () => {
    const [event] = advertise(["review", "compact"]);

    expect(event?.name).toBe("acp.commands");
    expect(commandsIn(event as { type: string })?.map((command) => command.name)).toEqual([
      "review",
      "compact",
    ]);
  });

  it("reads a withdrawal down to nothing as the empty list it is, not as silence", () => {
    const [event] = advertise([]);

    expect(commandsIn(event as { type: string })).toEqual([]);
  });

  it("says nothing about events that are not an advertisement", () => {
    const [plan] = wire({
      sessionUpdate: "plan",
      entries: [{ content: "step", priority: "medium", status: "pending" }],
    } as SessionUpdate);

    expect(commandsIn(plan as { type: string })).toBeNull();
    expect(commandsIn({ type: "TEXT_MESSAGE_CONTENT" })).toBeNull();
    // Malformed rather than a withdrawal — ignored, exactly as main's own cache ignores it, so the
    // hydrate and the live path can never disagree.
    expect(commandsIn({ type: "CUSTOM", name: "acp.commands", value: {} })).toBeNull();
  });
});

describe("the per-session store", () => {
  it("replaces the list wholesale — a withdrawn command is gone, not merged away", () => {
    const session = "store-wholesale";
    setCommands(session, [{ name: "review" }, { name: "compact" }]);
    setCommands(session, [{ name: "compact" }]);

    expect(getCommands(session).map((command) => command.name)).toEqual(["compact"]);
  });

  it("keeps one session's commands out of another's", () => {
    setCommands("store-a", [{ name: "only-a" }]);
    setCommands("store-b", []);

    expect(getCommands("store-a").map((command) => command.name)).toEqual(["only-a"]);
    expect(getCommands("store-b")).toEqual([]);
  });

  it("answers for a session it has never heard of, and for no session at all", () => {
    // The same reference both times, and between reads: `useSyncExternalStore` re-renders forever
    // if an unchanged snapshot is a new array.
    expect(getCommands("store-unknown")).toBe(getCommands(null));
    const session = "store-stable";
    setCommands(session, [{ name: "review" }]);
    expect(getCommands(session)).toBe(getCommands(session));
  });

  it("tells its readers when the list changed, and stops once they leave", () => {
    let notified = 0;
    const unsubscribe = subscribeCommands(() => {
      notified += 1;
    });

    setCommands("store-notify", [{ name: "review" }]);
    expect(notified).toBe(1);

    unsubscribe();
    setCommands("store-notify", []);
    expect(notified).toBe(1);
  });

  it("folds a live advertisement into what a session offers", () => {
    const session = "store-live";
    for (const event of advertise(["review"])) {
      const advertised = commandsIn(event);
      if (advertised !== null) setCommands(session, advertised);
    }
    expect(getCommands(session).map((command) => command.name)).toEqual(["review"]);

    for (const event of advertise([])) {
      const advertised = commandsIn(event);
      if (advertised !== null) setCommands(session, advertised);
    }
    expect(getCommands(session)).toEqual([]);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createEmitter,
  createSubscriber,
  type EventReceiverLike,
  type EventSenderLike,
} from "./events.js";
import { IpcContractError } from "./router.js";

/**
 * TC-0014. The one-way half of the boundary.
 *
 * An in-memory pair standing in for `webContents`/`ipcRenderer`, for the same reason `router.test.ts`
 * has one: DC-0006's whole point is that this is testable with no Electron runtime.
 */
function createFakeEvents(): EventSenderLike & EventReceiverLike & { sent: [string, unknown][] } {
  const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
  const sent: [string, unknown][] = [];

  return {
    sent,
    send(channel, payload) {
      sent.push([channel, payload]);
      for (const listener of listeners.get(channel) ?? []) listener({}, payload);
    },
    on(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
    },
  };
}

const chunk = {
  sessionId: "s-1",
  event: { type: "TEXT_MESSAGE_CONTENT", messageId: "m-1", delta: "hello" },
};

describe("the event channel", () => {
  it("delivers a valid event to a subscriber, parsed", () => {
    const fake = createFakeEvents();
    const received: unknown[] = [];

    createSubscriber(fake).subscribe("session:event", (payload) => received.push(payload));
    createEmitter(fake).emit("session:event", chunk);

    expect(received).toEqual([chunk]);
  });

  it("refuses to send a payload that does not match its schema", () => {
    const fake = createFakeEvents();
    const emitter = createEmitter(fake);

    // The bug belongs to whoever emitted this, so it throws where their stack still points at it.
    expect(() => emitter.emit("session:event", { sessionId: "s-1", event: {} } as never)).toThrow(
      IpcContractError,
    );

    // And nothing crossed the boundary.
    expect(fake.sent).toEqual([]);
  });

  it("reports a payload that arrives malformed rather than delivering it", () => {
    const fake = createFakeEvents();
    const handler = vi.fn();

    createSubscriber(fake).subscribe("session:event", handler);

    // Bypasses the emitter, the way a drifting main process or a bad actor would.
    expect(() => fake.send("session:event", { nope: true })).toThrow(IpcContractError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers to every subscriber, and stops delivering to one that unsubscribes", () => {
    const fake = createFakeEvents();
    const subscriber = createSubscriber(fake);
    const emitter = createEmitter(fake);

    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscriber.subscribe("session:event", first);
    subscriber.subscribe("session:event", second);

    emitter.emit("session:event", chunk);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    emitter.emit("session:event", chunk);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("tolerates unsubscribing twice", () => {
    const fake = createFakeEvents();
    const stop = createSubscriber(fake).subscribe("session:event", vi.fn());

    stop();
    expect(() => stop()).not.toThrow();
  });

  it("keeps the two events apart", () => {
    const fake = createFakeEvents();
    const subscriber = createSubscriber(fake);
    const onEvent = vi.fn();
    const onState = vi.fn();

    subscriber.subscribe("session:event", onEvent);
    subscriber.subscribe("session:state", onState);

    createEmitter(fake).emit("session:state", {
      sessionId: "s-1",
      state: "ready",
      error: null,
    });

    expect(onState).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("carries a failure with something a person can read", () => {
    const fake = createFakeEvents();
    const received: { state: string; error: { message: string } | null }[] = [];

    createSubscriber(fake).subscribe("session:state", (payload) => received.push(payload));
    createEmitter(fake).emit("session:state", {
      sessionId: "s-1",
      state: "failed",
      error: { code: "command_not_found", message: "npx is not on this application's PATH." },
    });

    expect(received[0]?.state).toBe("failed");
    expect(received[0]?.error?.message).toMatch(/PATH/);
  });

  it("passes an AG-UI event body through without knowing its shape", () => {
    const fake = createFakeEvents();
    const received: { event: Record<string, unknown> }[] = [];

    createSubscriber(fake).subscribe("session:event", (payload) => received.push(payload));

    // A variant this contract has never heard of must survive intact — AG-UI owns that vocabulary,
    // and restating it here would be a second copy of someone else's schema.
    createEmitter(fake).emit("session:event", {
      sessionId: "s-1",
      event: { type: "SOMETHING_NEW", nested: { count: 2 } },
    });

    expect(received[0]?.event).toEqual({ type: "SOMETHING_NEW", nested: { count: 2 } });
  });
});

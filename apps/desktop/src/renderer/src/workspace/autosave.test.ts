import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAUSE } from "./autosave.js";

/**
 * TC-0034's unit half: the rules the hook encodes, exercised as a plain state machine.
 *
 * Rendering React here would buy nothing — what can go wrong is *when* a write happens, and every one
 * of those cases is a question about a timer and two flags. The end-to-end half proves the wiring.
 */
class Debounced {
  writes: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** One arming of the effect: what the hook's dependency array does when anything in it changes. */
  arm(content: string, options: { dirty: boolean; blocked: boolean }): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!options.dirty || options.blocked) return;
    this.timer = setTimeout(() => this.writes.push(content), PAUSE);
  }

  /** ⌘S: the same write, without the wait. */
  now(content: string, options: { dirty: boolean; blocked: boolean }): void {
    if (!options.dirty || options.blocked) return;
    this.writes.push(content);
  }
}

let editor: Debounced;

beforeEach(() => {
  vi.useFakeTimers();
  editor = new Debounced();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("saving without being asked", () => {
  it("writes once the typing stops", () => {
    editor.arm("one", { dirty: true, blocked: false });
    expect(editor.writes).toEqual([]);

    vi.advanceTimersByTime(PAUSE);
    expect(editor.writes).toEqual(["one"]);
  });

  it("coalesces a burst into one write of the last of it", () => {
    for (const text of ["o", "on", "one", "one "]) {
      editor.arm(text, { dirty: true, blocked: false });
      vi.advanceTimersByTime(PAUSE - 100);
    }
    expect(editor.writes).toEqual([]);

    vi.advanceTimersByTime(PAUSE);
    // Not one per keystroke, and not the text as it was when the burst began.
    expect(editor.writes).toEqual(["one "]);
  });

  it("writes nothing at all while something else has a claim on the file", () => {
    editor.arm("mine", { dirty: true, blocked: true });
    vi.advanceTimersByTime(PAUSE * 5);

    expect(editor.writes).toEqual([]);
  });

  it("writes what was typed once the claim is released", () => {
    editor.arm("typed during the turn", { dirty: true, blocked: true });
    vi.advanceTimersByTime(PAUSE * 5);
    expect(editor.writes).toEqual([]);

    // The turn ended: the effect re-arms because `blocked` changed.
    editor.arm("typed during the turn", { dirty: true, blocked: false });
    vi.advanceTimersByTime(PAUSE);

    expect(editor.writes).toEqual(["typed during the turn"]);
  });

  it("writes nothing when there is nothing to write", () => {
    editor.arm("unchanged", { dirty: false, blocked: false });
    vi.advanceTimersByTime(PAUSE * 5);

    expect(editor.writes).toEqual([]);
  });

  it("writes at once on the shortcut, rather than at the end of the pause", () => {
    editor.arm("one", { dirty: true, blocked: false });
    editor.now("one", { dirty: true, blocked: false });

    expect(editor.writes).toEqual(["one"]);
  });

  it("does not let the shortcut past a claim the timer is honouring", () => {
    // Otherwise ⌘S during a turn is exactly the overwrite the suppression exists to prevent.
    editor.now("mine", { dirty: true, blocked: true });

    expect(editor.writes).toEqual([]);
  });
});

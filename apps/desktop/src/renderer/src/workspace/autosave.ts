import { useEffect, useRef } from "react";

/**
 * Writing without being asked (RQ-0008).
 *
 * One hook for every editor, because the debounce, the suppressions and the shortcut are the same
 * rules wherever the editing happens — and three copies of them would be three behaviours inside a
 * year.
 *
 * **The suppressions are the point.** Saving is not free here: these files are in a Git working tree,
 * so a write lands in the Git tab and in whatever the agent reads next. While a turn is streaming, or
 * while someone is being asked which version to keep, something else has a claim on the file — and a
 * timer is the wrong thing to settle that with. Held back, the work is still on screen; written, it
 * can be over the top of what the agent just did, before anyone has been told there was a
 * disagreement at all.
 */

/** Long enough that a burst of typing is one write, short enough that nobody notices waiting. */
export const PAUSE = 800;

export function useAutoSave({
  dirty,
  content,
  blocked,
  save,
}: {
  dirty: boolean;
  /**
   * What is being edited. The timer restarts whenever this changes, which is what turns a burst of
   * typing into **one** write of the last of it rather than a write every time the pause elapses.
   * `dirty` alone stays true across the whole burst and would never re-arm.
   */
  content: string;
  /** Something else has a claim on this file: a turn is streaming, or a choice is being asked. */
  blocked: boolean;
  save: () => void | Promise<void>;
}): void {
  // Held in a ref so the timer restarts when the *text* changes, not every time the parent hands over
  // a new closure — which would re-arm on every render and never fire.
  const write = useRef(save);
  write.current = save;

  // `content` is not read in here — it *is* the restart. Without it the timer would fire once, part
  // way through a burst of typing, rather than once after it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the content is the re-arm, not a read
  useEffect(() => {
    if (!dirty || blocked) return;

    const timer = setTimeout(() => void write.current(), PAUSE);
    return () => clearTimeout(timer);
  }, [dirty, blocked, content]);

  // ⌘S is not a different kind of saving — it is the same write, without the wait.
  useEffect(() => {
    return window.aibuildos.subscribe("app:command", (payload) => {
      if (payload.command !== "save" || !dirty || blocked) return;
      void write.current();
    });
  }, [dirty, blocked]);
}

import { useEffect, useSyncExternalStore } from "react";

/**
 * Work in motion, visible on a tab (RQ-0030#AC-1, ST-0048).
 *
 * `now/badge.ts`'s subscribable-module idiom, twice over: the MAIN session's `streaming` flag is
 * computed once in `Workspace.tsx` — the workspace outlives every tab, the same reason `streaming`
 * itself lives in `revision.ts` rather than in an editor — and written here in the one line
 * `Workspace.tsx` is allowed. Which *session* tabs are busy is tracked independently, right here:
 * `session:state` is a bridge-wide subscription, so `TabStrip` can listen to it on its own without
 * a second line in `Workspace.tsx` needing to exist at all.
 */

let mainStreaming = false;
const streamingListeners = new Set<() => void>();

export function setMainStreaming(next: boolean): void {
  if (next === mainStreaming) return;
  mainStreaming = next;
  for (const listener of streamingListeners) listener();
}

function getMainStreaming(): boolean {
  return mainStreaming;
}

function subscribeMainStreaming(listener: () => void): () => void {
  streamingListeners.add(listener);
  return () => streamingListeners.delete(listener);
}

export function useMainStreaming(): boolean {
  return useSyncExternalStore(subscribeMainStreaming, getMainStreaming);
}

let busy = new Set<string>();
const busyListeners = new Set<() => void>();

function getBusySessions(): Set<string> {
  return busy;
}

function subscribeBusySessions(listener: () => void): () => void {
  busyListeners.add(listener);
  return () => busyListeners.delete(listener);
}

export function useBusySessions(): Set<string> {
  return useSyncExternalStore(subscribeBusySessions, getBusySessions);
}

/**
 * Mounted once by `TabStrip` (always on screen, like `NowTab` feeding `badge.ts`): every
 * `session:state` the bridge emits, folded into which session ids are `busy` right now.
 */
export function useBusySessionStream(): void {
  useEffect(() => {
    return window.aibuildos.subscribe("session:state", (payload) => {
      const isBusy = payload.state === "busy";
      if (isBusy === busy.has(payload.sessionId)) return;
      const next = new Set(busy);
      if (isBusy) next.add(payload.sessionId);
      else next.delete(payload.sessionId);
      busy = next;
      for (const listener of busyListeners) listener();
    });
  }, []);
}

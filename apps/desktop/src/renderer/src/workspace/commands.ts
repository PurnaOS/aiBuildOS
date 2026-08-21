import { useEffect, useSyncExternalStore } from "react";
import type { Command } from "./agentControls.js";

/**
 * What the harness says it can do, per session, live (RQ-0051#AC-3, ST-0069).
 *
 * `toolCall.ts`'s store idiom — a module-level Map, one `session:event` subscription, read through
 * `useSyncExternalStore` and hydrated once from an invoke — rather than component state, because the
 * composer's menu is not the only thing that will ever want this list, and session state is not the
 * zustand store's business (DC-0005). No new IPC channel: the transport is already whole.
 *
 * The one rule the protocol imposes: **the agent resends the complete list every time and the client
 * replaces it wholesale.** Nothing here merges or appends; a command the harness stops naming is
 * gone (AC-3).
 */

/** The bridge's own name for the update this store follows (`packages/acp/src/bridge.ts`). */
const ACP_COMMANDS = "acp.commands";

/** One shared empty snapshot: `useSyncExternalStore` loops if an unchanged read returns a new array. */
const NONE: readonly Command[] = [];

// ponytail: never evicted — one list of small objects per session, which is nothing next to the
// transcript those sessions produce. Evict on `session:state` closed if that ever stops being true.
const bySession = new Map<string, readonly Command[]>();
const listeners = new Set<() => void>();

export function getCommands(sessionId: string | null): readonly Command[] {
  if (sessionId === null) return NONE;
  return bySession.get(sessionId) ?? NONE;
}

export function subscribeCommands(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Replaces one session's list, whole (AC-3). The array is stored as given, so a read that changed
 * nothing keeps returning the same reference. */
export function setCommands(sessionId: string, commands: readonly Command[]): void {
  bySession.set(sessionId, commands);
  for (const listener of listeners) listener();
}

/**
 * The list a `session:event` payload carries, or `null` when it says nothing about commands.
 *
 * An `acp.commands` event whose payload has no `availableCommands` at all is malformed rather than a
 * withdrawal, and is ignored — the same call main's own `remember()` makes for its cache, so the
 * hydrate below and the live path can never disagree. A withdrawal is an explicit empty list.
 */
export function commandsIn(event: {
  type: string;
  name?: string;
  value?: unknown;
}): readonly Command[] | null {
  if (event.type !== "CUSTOM" || event.name !== ACP_COMMANDS) return null;
  const advertised = (event.value as { availableCommands?: Command[] } | undefined)
    ?.availableCommands;
  return Array.isArray(advertised) ? advertised : null;
}

/**
 * One session's advertised commands, live.
 *
 * Subscribes *before* asking what was already known, because an agent announces its commands as the
 * session opens — long before any menu exists to hear it — and the answer must not land on top of a
 * newer update. Main writes its cache before forwarding the event, so a snapshot taken after a
 * subscription is never staler than what that subscription has already applied; `sawEvent` is all
 * the ordering this needs. Hydration is unconditional otherwise: a menu that unmounted through a
 * withdrawal and mounted again must not trust what the store still holds.
 */
export function useSessionCommands(sessionId: string | null): readonly Command[] {
  useEffect(() => {
    if (sessionId === null) return;
    let sawEvent = false;

    const unsubscribe = window.aibuildos.subscribe("session:event", (payload) => {
      if (payload.sessionId !== sessionId) return;
      const advertised = commandsIn(
        payload.event as { type: string; name?: string; value?: unknown },
      );
      if (advertised === null) return;
      sawEvent = true;
      setCommands(sessionId, advertised);
    });

    void window.aibuildos.invoke("session:controls", { sessionId }).then((known) => {
      if (sawEvent) return;
      setCommands(sessionId, known.commands as unknown as Command[]);
    });

    return unsubscribe;
  }, [sessionId]);

  return useSyncExternalStore(subscribeCommands, () => getCommands(sessionId));
}

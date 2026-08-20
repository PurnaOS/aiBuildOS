/**
 * The Now tab's needs-you badge (RQ-0021#AC-3, ST-0038#AC-2).
 *
 * A plain subscribable module rather than a context: the pinned Now tab's *label* is drawn by
 * TabStrip, outside NowTab's own subtree, and NowTab is the only thing that knows the count.
 * `useSyncExternalStore` is the smallest way to bridge the two without a new dependency or reworking
 * either component's fixed props.
 */
let count = 0;
const listeners = new Set<() => void>();

export function setNowBadge(next: number): void {
  if (next === count) return;
  count = next;
  for (const listener of listeners) listener();
}

export function getNowBadge(): number {
  return count;
}

export function subscribeNowBadge(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

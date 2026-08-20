/**
 * The project watcher (RQ-0026, DC-0022): chokidar over an open project's root, debounced into
 * one `project:changed` event, the revision counter's one ambient source.
 *
 * A stub until ST-0043 lands — the event, the channel and the lifecycle wiring exist so the lane
 * building this never edits the shared files. One watcher per project id; watching a project
 * again replaces the old watcher; stopping is idempotent.
 */

export function watchProject(
  _projectId: string,
  _projectPath: string,
  _onChange: () => void,
): void {
  // Not watching yet: freshness stays turn-end-and-own-writes until ST-0043 replaces this.
}

export function stopWatching(_projectId: string): void {}

export function stopAllWatching(): void {}

/**
 * The record-read cache seam (RQ-0026#AC-6): bumped by the watcher lane when `docs/` changes so
 * `project:record` can answer from cache between changes. A stub generation that never moves
 * means "no cache yet" — every read parses, exactly as today.
 */
export function recordGeneration(_projectPath: string): number {
  return -1;
}

/**
 * Real PTY terminals in the project (RQ-0038, DC-0026).
 *
 * node-pty is a native module built for Electron's ABI, so it must **never be imported at the top
 * level** — vitest runs this file on plain Node, where the rebuilt binary throws a
 * NODE_MODULE_VERSION mismatch. The registry takes an injected pty factory instead (the same lazy
 * resolution `previews.ts` uses for `BrowserWindow`): unit tests drive a fake, and only `ipc.ts`
 * inside Electron performs the one real `import("node-pty")`.
 *
 * The user's own typed commands cross no supervision — the same trust as their system terminal.
 * Main's guards are narrower: the cwd comes from the project registry (never the renderer), and
 * input only reaches terminals this process opened.
 */

/** What the registry needs from a pty — the node-pty surface, narrowed to what is used. */
export interface PtyLike {
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type PtyFactory = (options: { cwd: string; cols: number; rows: number }) => PtyLike;

export interface TerminalRow {
  readonly terminalId: string;
  readonly startedAt: string;
}

/** RQ-0038 — lands with ST-0056. */
export function openTerminal(
  _factory: PtyFactory,
  _projectId: string,
  _cwd: string,
  _emit: (channel: string, payload: unknown) => void,
): { ok: true; terminalId: string } | { ok: false; message: string } {
  return { ok: false, message: "terminals are not implemented yet." };
}

export function writeTerminal(_terminalId: string, _data: string): void {}

export function resizeTerminal(_terminalId: string, _cols: number, _rows: number): void {}

export function closeTerminal(_terminalId: string): void {}

export function listTerminals(_projectId: string): TerminalRow[] {
  return [];
}

/** Wired into `project:close` — a project's terminals die with it. */
export function killTerminalsForProject(_projectId: string): void {}

/** Wired into `before-quit`, beside `killChecks` and `killPreviews`. */
export function killTerminals(): void {}

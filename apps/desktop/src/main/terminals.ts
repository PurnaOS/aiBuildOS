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

export type PtyFactory = (options: {
  cwd: string;
  cols: number;
  rows: number;
  /** The shell binary to run — `$SHELL`/`COMSPEC` resolution lives in this module, not the factory. */
  file: string;
}) => PtyLike;

export interface TerminalRow {
  readonly terminalId: string;
  readonly startedAt: string;
}

interface Terminal {
  readonly pty: PtyLike;
  readonly projectId: string;
  readonly startedAt: string;
}

const terminals = new Map<string, Terminal>();
let minted = 1;

/** POSIX honours `$SHELL`; Windows has no such convention and uses `COMSPEC` instead. */
function defaultShell(): string {
  return process.platform === "win32"
    ? (process.env.COMSPEC ?? "cmd.exe")
    : (process.env.SHELL ?? "/bin/sh");
}

/** RQ-0038 — opens a real PTY rooted at `cwd` (resolved main-side, never renderer-supplied). */
export function openTerminal(
  factory: PtyFactory,
  projectId: string,
  cwd: string,
  emit: (channel: string, payload: unknown) => void,
): { ok: true; terminalId: string } | { ok: false; message: string } {
  const terminalId = `t${minted++}`;
  let pty: PtyLike;
  try {
    pty = factory({ cwd, cols: 80, rows: 24, file: defaultShell() });
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }

  terminals.set(terminalId, { pty, projectId, startedAt: new Date().toISOString() });

  pty.onData((chunk) => emit("terminal:data", { terminalId, chunk }));
  pty.onExit(({ exitCode }) => {
    terminals.delete(terminalId);
    emit("terminal:exit", { terminalId, exitCode });
  });

  return { ok: true, terminalId };
}

/** No-op on an unknown id: the pty may have exited between the renderer's last render and this call. */
export function writeTerminal(terminalId: string, data: string): void {
  terminals.get(terminalId)?.pty.write(data);
}

export function resizeTerminal(terminalId: string, cols: number, rows: number): void {
  terminals.get(terminalId)?.pty.resize(cols, rows);
}

export function closeTerminal(terminalId: string): void {
  const terminal = terminals.get(terminalId);
  if (!terminal) return;
  terminals.delete(terminalId);
  terminal.pty.kill();
}

export function listTerminals(projectId: string): TerminalRow[] {
  return [...terminals.entries()]
    .filter(([, terminal]) => terminal.projectId === projectId)
    .map(([terminalId, terminal]) => ({ terminalId, startedAt: terminal.startedAt }));
}

// ponytail: no scrollback buffer — a renderer reload reattaches to a blank view while the pty
// lives on (DC-0026's recorded ceiling). Upgrade path: a main-side ring buffer, when it earns its
// place.

/** Wired into `project:close` — a project's terminals die with it. */
export function killTerminalsForProject(projectId: string): void {
  for (const [terminalId, terminal] of terminals) {
    if (terminal.projectId !== projectId) continue;
    terminals.delete(terminalId);
    terminal.pty.kill();
  }
}

/** Wired into `before-quit`, beside `killChecks` and `killPreviews`. */
export function killTerminals(): void {
  for (const terminal of terminals.values()) terminal.pty.kill();
  terminals.clear();
}

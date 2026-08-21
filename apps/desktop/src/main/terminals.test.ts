import { afterEach, describe, expect, it } from "vitest";
import {
  closeTerminal,
  killTerminals,
  killTerminalsForProject,
  listTerminals,
  openTerminal,
  type PtyFactory,
  resizeTerminal,
  writeTerminal,
} from "./terminals.js";

/**
 * The registry against a fake `PtyFactory` — node-pty is a native module built for Electron's ABI
 * (DC-0026) and must never load under vitest. The fake stands in for node-pty's onData/onExit/
 * write/resize/kill surface and records what the registry does with it.
 */
interface FakePty {
  readonly cwd: string;
  readonly file: string;
  readonly writes: string[];
  readonly resizes: { cols: number; rows: number }[];
  killed: boolean;
  emitData(chunk: string): void;
  emitExit(exitCode: number): void;
}

function fakeFactory(): { factory: PtyFactory; ptys: FakePty[] } {
  const ptys: FakePty[] = [];
  const factory: PtyFactory = ({ cwd, file }) => {
    let onData: (chunk: string) => void = () => {};
    let onExit: (event: { exitCode: number }) => void = () => {};
    const pty: FakePty = {
      cwd,
      file,
      writes: [],
      resizes: [],
      killed: false,
      emitData: (chunk) => onData(chunk),
      emitExit: (exitCode) => onExit({ exitCode }),
    };
    ptys.push(pty);
    return {
      onData: (listener) => {
        onData = listener;
      },
      onExit: (listener) => {
        onExit = listener;
      },
      write: (data) => pty.writes.push(data),
      resize: (cols, rows) => pty.resizes.push({ cols, rows }),
      kill: () => {
        pty.killed = true;
      },
    };
  };
  return { factory, ptys };
}

/** No fixed shell asserted — only that whatever `terminals.ts` resolved was passed through. */
function open(factory: PtyFactory, projectId: string, cwd: string) {
  return openTerminal(factory, projectId, cwd, () => {});
}

describe("the terminal registry", () => {
  // Every terminal opened by a test must die with it — nothing here should outlive its `it`.
  afterEach(() => {
    killTerminals();
  });

  it("opens a pty rooted at the given cwd, running the resolved shell", () => {
    const { factory, ptys } = fakeFactory();
    const result = openTerminal(factory, "project-1", "/repo/project-1", () => {});

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(ptys[0]?.cwd).toBe("/repo/project-1");
    // $SHELL on POSIX, COMSPEC on win32 (RQ-0038) — asserted against the same resolution the
    // module uses, so this fails if the branch ever inverts, not if a dev's $SHELL changes.
    const shell =
      process.platform === "win32"
        ? (process.env.COMSPEC ?? "cmd.exe")
        : (process.env.SHELL ?? "/bin/sh");
    expect(ptys[0]?.file).toBe(shell);
    expect(listTerminals("project-1")).toEqual([
      { terminalId: result.terminalId, startedAt: expect.any(String) },
    ]);
    expect(listTerminals("other-project")).toEqual([]);
  });

  it("streams data and exit events with the right terminalId, and drops the id from the registry on exit", () => {
    const { factory, ptys } = fakeFactory();
    const emitted: { channel: string; payload: unknown }[] = [];
    const result = openTerminal(factory, "project-1", "/repo/a", (channel, payload) =>
      emitted.push({ channel, payload }),
    );
    if (!result.ok) throw new Error("expected the terminal to open");

    ptys[0]?.emitData("hello\n");
    expect(emitted).toContainEqual({
      channel: "terminal:data",
      payload: { terminalId: result.terminalId, chunk: "hello\n" },
    });

    ptys[0]?.emitExit(0);
    expect(emitted).toContainEqual({
      channel: "terminal:exit",
      payload: { terminalId: result.terminalId, exitCode: 0 },
    });
    // Exit retires the registry entry — closing it again, or writing to it, is a no-op, not a crash.
    expect(listTerminals("project-1")).toEqual([]);
  });

  it("routes input to the terminal it was addressed to, not any other open one", () => {
    const { factory, ptys } = fakeFactory();
    const a = open(factory, "project-1", "/repo/a");
    const b = open(factory, "project-1", "/repo/b");
    if (!a.ok || !b.ok) throw new Error("expected both terminals to open");

    writeTerminal(a.terminalId, "ls\n");

    expect(ptys[0]?.writes).toEqual(["ls\n"]);
    expect(ptys[1]?.writes).toEqual([]);
  });

  it("forwards a resize straight to the pty", () => {
    const { factory, ptys } = fakeFactory();
    const result = open(factory, "project-1", "/repo/a");
    if (!result.ok) throw new Error("expected the terminal to open");

    resizeTerminal(result.terminalId, 120, 40);

    expect(ptys[0]?.resizes).toEqual([{ cols: 120, rows: 40 }]);
  });

  it("kills the pty and drops it from the registry on close", () => {
    const { factory, ptys } = fakeFactory();
    const result = open(factory, "project-1", "/repo/a");
    if (!result.ok) throw new Error("expected the terminal to open");

    closeTerminal(result.terminalId);

    expect(ptys[0]?.killed).toBe(true);
    expect(listTerminals("project-1")).toEqual([]);
  });

  it("no-ops write/resize/close against an id it does not hold", () => {
    expect(() => writeTerminal("no-such-id", "x")).not.toThrow();
    expect(() => resizeTerminal("no-such-id", 10, 10)).not.toThrow();
    expect(() => closeTerminal("no-such-id")).not.toThrow();
  });

  it("kills only one project's terminals on killTerminalsForProject", () => {
    const { factory, ptys } = fakeFactory();
    const a = open(factory, "project-1", "/repo/a");
    const b = open(factory, "project-2", "/repo/b");
    if (!a.ok || !b.ok) throw new Error("expected both terminals to open");

    killTerminalsForProject("project-1");

    expect(ptys[0]?.killed).toBe(true);
    expect(ptys[1]?.killed).toBe(false);
    expect(listTerminals("project-1")).toEqual([]);
    expect(listTerminals("project-2")).toEqual([
      { terminalId: b.terminalId, startedAt: expect.any(String) },
    ]);
  });

  it("kills every terminal, across every project, on killTerminals", () => {
    const { factory, ptys } = fakeFactory();
    const a = open(factory, "project-1", "/repo/a");
    const b = open(factory, "project-2", "/repo/b");
    if (!a.ok || !b.ok) throw new Error("expected both terminals to open");

    killTerminals();

    expect(ptys.every((pty) => pty.killed)).toBe(true);
    expect(listTerminals("project-1")).toEqual([]);
    expect(listTerminals("project-2")).toEqual([]);
  });
});

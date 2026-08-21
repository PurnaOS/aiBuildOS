import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { button, eyebrow, focusRing, mono } from "../ui.js";
import { terminalLabel, terminalStatus } from "./derive.js";

/**
 * The dock's Terminals section (RQ-0038, ST-0056, DC-0026): a row per PTY this dock has opened, and
 * — for whichever row is selected — a live `@xterm/xterm` view filling the space below the list.
 *
 * Rows are this component's own state, not a mirror of `terminal:list`: main's registry forgets a
 * terminal the moment its pty exits (`terminals.ts`'s `pty.onExit` deletes the entry before emitting
 * `terminal:exit`), so an "exited" row would vanish from a re-fetched list the instant it needs to
 * say so. `terminal:list` only seeds what survived from before this component mounted; every row
 * this component opens itself is tracked locally from `terminal:open` through to `terminal:close`.
 */

interface Row {
  readonly terminalId: string;
  readonly startedAt: string;
  /** `undefined` — still running. `null`/a number — `terminal:exit`'s own code (RQ-0038#AC-4). */
  readonly exitCode: number | null | undefined;
}

export function Terminals({ projectId }: { projectId: string }): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [cwdBasename, setCwdBasename] = useState("project");

  // Seeded once per project: every terminal this project's registry still holds when the dock first
  // asks (a survivor from before this mount). New ones are added locally as they open.
  useEffect(() => {
    let live = true;
    setRows([]);
    setActiveId(null);
    void window.aibuildos.invoke("terminal:list", { projectId }).then((result) => {
      if (!live) return;
      setRows(result.terminals.map((row) => ({ ...row, exitCode: undefined })));
    });
    void window.aibuildos.invoke("project:list", undefined).then((projects) => {
      if (!live) return;
      const project = projects.find((p) => p.id === projectId);
      if (project !== undefined) setCwdBasename(project.path.split(/[/\\]/).pop() ?? project.path);
    });
    return () => {
      live = false;
    };
  }, [projectId]);

  useEffect(() => {
    return window.aibuildos.subscribe("terminal:exit", (payload) => {
      setRows((current) =>
        current.map((row) =>
          row.terminalId === payload.terminalId ? { ...row, exitCode: payload.exitCode } : row,
        ),
      );
    });
  }, []);

  const openNew = async (): Promise<void> => {
    setOpening(true);
    try {
      const result = await window.aibuildos.invoke("terminal:open", { projectId });
      if (result.ok) {
        setRows((current) => [
          ...current,
          {
            terminalId: result.terminalId,
            startedAt: new Date().toISOString(),
            exitCode: undefined,
          },
        ]);
        setActiveId(result.terminalId);
      }
    } finally {
      setOpening(false);
    }
  };

  const closeRow = async (terminalId: string): Promise<void> => {
    await window.aibuildos.invoke("terminal:close", { terminalId });
    setRows((current) => current.filter((row) => row.terminalId !== terminalId));
    setActiveId((current) => (current === terminalId ? null : current));
  };

  return (
    <section className="mt-4">
      <div className="flex items-center justify-between">
        <p data-testid="dock-section-terminals" className={eyebrow}>
          Terminals
        </p>
        <button
          type="button"
          data-testid="terminal-new"
          disabled={opening}
          onClick={() => void openNew()}
          className={`${button} ${focusRing} text-xs`}
        >
          + New terminal
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="mt-1.5 text-xs text-neutral-500">No terminals open.</p>
      ) : (
        <div className="mt-1.5 flex flex-col gap-1">
          {rows.map((row) => (
            <div
              key={row.terminalId}
              data-testid={`terminal-row-${row.terminalId}`}
              className={`flex items-center justify-between gap-2 rounded border px-2 py-1 ${
                row.terminalId === activeId
                  ? "border-neutral-400 dark:border-neutral-600"
                  : "border-neutral-200 dark:border-neutral-800"
              }`}
            >
              <button
                type="button"
                data-testid={`terminal-select-${row.terminalId}`}
                onClick={() => setActiveId(row.terminalId)}
                className={`flex-1 text-left text-xs ${focusRing}`}
              >
                <span className={mono}>{terminalLabel(row.terminalId, cwdBasename)}</span>
                <span
                  data-testid={`terminal-status-${row.terminalId}`}
                  className="ml-2 text-neutral-500"
                >
                  {terminalStatus(row.exitCode)}
                </span>
              </button>
              <button
                type="button"
                data-testid={`terminal-close-${row.terminalId}`}
                onClick={() => void closeRow(row.terminalId)}
                className={`${button} ${focusRing} px-1.5 py-0 text-xs`}
              >
                Close
              </button>
            </div>
          ))}
        </div>
      )}

      {activeId !== null && (
        <div className="mt-2 h-64 overflow-hidden rounded border border-neutral-200 bg-black dark:border-neutral-800">
          <TerminalView key={activeId} terminalId={activeId} />
        </div>
      )}
    </section>
  );
}

/** One PTY's live view (RQ-0038#AC-2, AC-3): xterm's own DOM renderer (never canvas/webgl —
 * that's what keeps its output plain text in the DOM, assertable the same way any other panel is),
 * the fit addon sizing it to the container, and a lightly-debounced resize propagated to the pty so
 * full-screen programs see the size they are actually drawn at. */
function TerminalView({ terminalId }: { terminalId: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = new Terminal({ convertEol: true, cursorBlink: true, fontSize: 12 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const container = containerRef.current;
    if (container !== null) term.open(container);
    fit.fit();
    void window.aibuildos.invoke("terminal:resize", {
      terminalId,
      cols: term.cols,
      rows: term.rows,
    });

    const input = term.onData((data) => {
      void window.aibuildos.invoke("terminal:input", { terminalId, data });
    });
    const unsubData = window.aibuildos.subscribe("terminal:data", (payload) => {
      if (payload.terminalId === terminalId) term.write(payload.chunk);
    });
    // Stops writing on its own: main never emits another terminal:data for an exited pty. This just
    // says so, in the pane itself.
    const unsubExit = window.aibuildos.subscribe("terminal:exit", (payload) => {
      if (payload.terminalId === terminalId) term.write("\r\n[exited]\r\n");
    });

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fit.fit();
        void window.aibuildos.invoke("terminal:resize", {
          terminalId,
          cols: term.cols,
          rows: term.rows,
        });
      }, 120);
    });
    if (container !== null) observer.observe(container);

    return () => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      observer.disconnect();
      input.dispose();
      unsubData();
      unsubExit();
      term.dispose();
    };
  }, [terminalId]);

  return <div ref={containerRef} data-testid="terminal-view" className="h-full w-full p-1" />;
}

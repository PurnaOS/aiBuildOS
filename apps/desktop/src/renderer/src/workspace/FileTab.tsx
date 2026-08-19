import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { useCallback, useEffect, useRef, useState } from "react";
import { darkEditor, useDarkAppearance } from "../appearance.js";
import { button, eyebrow, focusRing, mono, primary } from "../ui.js";
import { Diff } from "./Diff.js";

/**
 * A file, open for editing (RQ-0005#AC-1 to AC-4, AC-11).
 *
 * The case this is really built around is the one that would otherwise arrive as a bug report: the
 * agent edits a file you have open. If your copy is untouched it simply reloads and says so. If you
 * have unsaved edits, **neither side is discarded** — you are told, shown the difference, and choose.
 * Silently overwriting either one is the single outcome nobody can defend.
 */
type Conflict = { theirs: string } | null;

export function FileTab({
  projectId,
  path,
  sessionId,
  onDirtyChange,
}: {
  projectId: string;
  path: string;
  /** Watched so a finished turn triggers a re-read: that is when the agent has changed things. */
  sessionId: string | null;
  onDirtyChange?: (dirty: boolean) => void;
}): React.JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<Conflict>(null);
  const dark = useDarkAppearance();

  /** What is on disk as far as this tab knows. Dirty is a comparison, not a flag to keep in step. */
  const onDisk = useRef<string>("");
  const dirty = text !== null && text !== onDisk.current;

  // Held in a ref so this fires when *dirty* changes, not every time the parent re-renders and hands
  // over a new closure — which would loop: report dirty, parent re-renders, report again.
  const report = useRef(onDirtyChange);
  report.current = onDirtyChange;
  useEffect(() => {
    report.current?.(dirty);
  }, [dirty]);

  const load = useCallback(async () => {
    const result = await window.aibuildos.invoke("project:file", { id: projectId, path });
    if (result.text === null) {
      setProblem(result.problem);
      return;
    }
    onDisk.current = result.text;
    setText(result.text);
    setProblem(null);
  }, [projectId, path]);

  useEffect(() => {
    void load();
  }, [load]);

  // When a turn ends the agent has stopped changing things, which is the moment to look.
  useEffect(() => {
    if (sessionId === null) return;

    return window.aibuildos.subscribe("session:event", (payload) => {
      if (payload.sessionId !== sessionId) return;
      const type = (payload.event as { type: string }).type;
      if (type !== "RUN_FINISHED" && type !== "RUN_ERROR") return;

      void window.aibuildos
        .invoke("project:file", { id: projectId, path })
        .then((result) => {
          if (result.text === null || result.text === onDisk.current) return;

          // Untouched here: take theirs, and say so.
          if (text === onDisk.current) {
            onDisk.current = result.text;
            setText(result.text);
            return;
          }
          // Edited here: keep both until someone chooses.
          setConflict({ theirs: result.text });
        })
        .catch(() => undefined);
    });
  }, [projectId, path, sessionId, text]);

  const save = async (): Promise<void> => {
    if (text === null) return;
    setSaving(true);
    try {
      const { problem: failed } = await window.aibuildos.invoke("project:save", {
        id: projectId,
        path,
        text,
      });
      setProblem(failed);
      // Only what was actually written becomes the new baseline; a failed save stays dirty.
      if (failed === null) onDisk.current = text;
    } finally {
      setSaving(false);
    }
  };

  if (problem !== null && text === null) {
    return (
      <p data-testid="file-problem" className="p-6 text-sm text-red-600">
        {problem}
      </p>
    );
  }
  if (text === null) return <p className="p-6 text-sm text-neutral-500">Loading…</p>;

  return (
    <div data-testid="file-tab" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-1.5 dark:border-neutral-800">
        <span className={`min-w-0 flex-1 truncate text-xs ${mono}`}>{path}</span>
        {dirty && (
          <span data-testid="file-dirty" className={eyebrow}>
            unsaved
          </span>
        )}
        <button
          type="button"
          data-testid="file-save"
          disabled={!dirty || saving}
          onClick={() => void save()}
          className={`${button} ${focusRing}`}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {problem !== null && (
        <p
          data-testid="file-save-problem"
          className="border-b border-neutral-200 px-3 py-2 text-xs text-red-600 dark:border-neutral-800"
        >
          {problem}
        </p>
      )}

      {conflict !== null && (
        <div
          data-testid="file-conflict"
          className="border-b border-neutral-200 bg-amber-50 px-3 py-2.5 dark:border-neutral-800 dark:bg-amber-950/30"
        >
          <p className="text-xs text-amber-800 dark:text-amber-300">
            The agent changed this file while you were editing it. Nothing has been overwritten.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="conflict-keep-mine"
              onClick={() => setConflict(null)}
              className={`${primary} ${focusRing}`}
            >
              Keep mine
            </button>
            <button
              type="button"
              data-testid="conflict-take-theirs"
              onClick={() => {
                onDisk.current = conflict.theirs;
                setText(conflict.theirs);
                setConflict(null);
              }}
              className={`${button} ${focusRing}`}
            >
              Take the agent's
            </button>
          </div>
          <div className="mt-2">
            <Diff path={path} oldText={text} newText={conflict.theirs} />
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <CodeMirror
          value={text}
          onChange={setText}
          theme={dark ? darkEditor : "light"}
          extensions={
            path.endsWith(".md") ? [markdown()] : [javascript({ typescript: true, jsx: true })]
          }
          basicSetup={{ lineNumbers: true, foldGutter: false }}
          height="100%"
        />
      </div>
    </div>
  );
}

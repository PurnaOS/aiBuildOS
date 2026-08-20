import type { ChannelResponse } from "@aibuildos/ipc";
import { ChevronDown, ChevronRight, File, Folder } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Loading } from "../Loading.js";
import { eyebrow, field, focusRing, mono, primary, relativeTime } from "../ui.js";
import { NewFile } from "./NewArtifact.js";
import { useBump, useRevision } from "./revision.js";
import type { Tab } from "./TabStrip.js";

/**
 * The files rail (ST-0012): the working tree, and the same tree as Git sees it.
 *
 * The explorer / source-control split every developer already has in their hands. Directories are
 * read **when they are opened**, never all at once — a rail that walks a whole working tree to show
 * one folder is a rail that stalls on a large repository.
 */
type Tree = ChannelResponse<"project:tree">;
type Changes = ChannelResponse<"project:changes">;
type Entry = Tree["entries"][number];

export function FilesRail({
  projectId,
  onOpen,
  onCreated,
}: {
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  /** A newly created file: opened straight away, and the tree re-read so it is there to see. */
  onCreated: (path: string) => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<"files" | "git">("files");
  /** Open when a file is being named, holding the directory it will be made in. */
  const [creating, setCreating] = useState<{ directory: string } | null>(null);

  const menu = useCallback(async (entry: { path: string; directory: boolean }) => {
    const chosen = await window.aibuildos.invoke("project:file-menu", entry);
    // A dismissal answers `null`, and does nothing.
    if (chosen.action === "new-file") setCreating({ directory: chosen.directory });
  }, []);

  return (
    <div data-testid="files-rail" className="relative flex h-full flex-col overflow-hidden">
      <div className="flex h-[34px] shrink-0 items-stretch border-b border-neutral-200 dark:border-neutral-800">
        {(["files", "git"] as const).map((name) => (
          <button
            key={name}
            type="button"
            data-testid={`rail-tab-${name}`}
            data-active={tab === name}
            onClick={() => setTab(name)}
            className={`px-3.5 text-xs capitalize ${focusRing} ${
              tab === name
                ? "font-medium shadow-[inset_0_-2px_0_currentColor]"
                : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            }`}
          >
            {name}
          </button>
        ))}
        <span className="flex flex-1 items-center justify-end pr-2">
          <NewFile
            projectId={projectId}
            onCreated={onCreated}
            creating={creating}
            onOpen={() => setCreating({ directory: "" })}
            onClose={() => setCreating(null)}
          />
        </span>
      </div>

      {tab === "files" ? (
        <FileTree projectId={projectId} onOpen={onOpen} onMenu={(entry) => void menu(entry)} />
      ) : (
        <GitChanges projectId={projectId} onOpen={onOpen} />
      )}
    </div>
  );
}

function FileTree({
  projectId,
  onOpen,
  onMenu,
}: {
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  /** Right-click: the platform's own menu, which may answer with a directory to create in. */
  onMenu: (entry: { path: string; directory: boolean }) => void;
}): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-auto py-1.5">
      <Directory projectId={projectId} path="" depth={0} onOpen={onOpen} onMenu={onMenu} />
    </div>
  );
}

function Directory({
  projectId,
  path,
  depth,
  onOpen,
  onMenu,
}: {
  projectId: string;
  path: string;
  depth: number;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  /** Right-click: the platform's own menu, which may answer with a directory to create in. */
  onMenu: (entry: { path: string; directory: boolean }) => void;
}): React.JSX.Element {
  const [tree, setTree] = useState<Tree | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // Every expanded directory is its own component, so each re-reads itself; a directory nobody has
  // opened costs nothing, which is the same reason the tree expands lazily in the first place.
  const revision = useRevision();

  // `revision` is not read in here — it *is* the trigger. It moves when the project's files may
  // have changed underneath what is on screen, and re-reading is the whole point of depending on it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is a trigger, not a read
  useEffect(() => {
    let live = true;
    void window.aibuildos
      .invoke("project:tree", { id: projectId, path })
      .then((next) => {
        if (live) setTree(next);
      })
      .catch(() => {
        if (live) setTree({ entries: [], problem: "That folder could not be read." });
      });
    return () => {
      live = false;
    };
  }, [projectId, path, revision]);

  const toggle = useCallback((entryPath: string) => {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(entryPath)) next.delete(entryPath);
      else next.add(entryPath);
      return next;
    });
  }, []);

  if (tree === null) {
    return <Loading className="px-3 py-1 text-xs" />;
  }
  if (tree.problem) {
    return <p className="px-3 py-1 text-xs text-red-600">{tree.problem}</p>;
  }

  return (
    <>
      {tree.entries.map((entry) => (
        <div key={entry.path}>
          <Row
            entry={entry}
            depth={depth}
            expanded={open.has(entry.path)}
            onToggle={() => toggle(entry.path)}
            onOpen={onOpen}
            onMenu={onMenu}
          />
          {/* Mounted only once opened, which is what makes the read lazy. */}
          {entry.directory && open.has(entry.path) && (
            <Directory
              projectId={projectId}
              path={entry.path}
              depth={depth + 1}
              onOpen={onOpen}
              onMenu={onMenu}
            />
          )}
        </div>
      ))}
    </>
  );
}

function Row({
  entry,
  depth,
  expanded,
  onToggle,
  onOpen,
  onMenu,
}: {
  entry: Entry;
  depth: number;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  /** Right-click: the platform's own menu, which may answer with a directory to create in. */
  onMenu: (entry: { path: string; directory: boolean }) => void;
}): React.JSX.Element {
  const open = () =>
    entry.directory
      ? onToggle()
      : onOpen({ id: entry.path, kind: "file", title: entry.name }, { preview: true });

  return (
    <button
      type="button"
      data-testid="file-row"
      onClick={open}
      onContextMenu={() => onMenu({ path: entry.path, directory: entry.directory })}
      onDoubleClick={() =>
        entry.directory
          ? undefined
          : onOpen({ id: entry.path, kind: "file", title: entry.name }, { preview: false })
      }
      style={{ paddingLeft: `${10 + depth * 12}px` }}
      className={`flex w-full items-center gap-1.5 py-0.5 pr-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900 ${focusRing}`}
    >
      {entry.directory ? (
        expanded ? (
          <ChevronDown size={11} className="shrink-0 text-neutral-400" />
        ) : (
          <ChevronRight size={11} className="shrink-0 text-neutral-400" />
        )
      ) : (
        <span className="w-[11px] shrink-0" />
      )}
      {entry.directory ? (
        <Folder size={12} className="shrink-0 text-neutral-400" />
      ) : (
        <File size={12} className="shrink-0 text-neutral-400" />
      )}
      {/* Amber where Git says the path changed. Never colour alone — the Git tab lists them by name. */}
      <span
        className={`truncate text-xs ${mono} ${entry.changed ? "text-amber-600" : ""}`}
        title={entry.path}
      >
        {entry.name}
      </span>
    </button>
  );
}

function GitChanges({
  projectId,
  onOpen,
}: {
  projectId: string;
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
}): React.JSX.Element {
  const [changes, setChanges] = useState<Changes | null>(null);
  const revision = useRevision();
  const bump = useBump();

  // `revision` is not read in here — it *is* the trigger. It moves when the project's files may
  // have changed underneath what is on screen, and re-reading is the whole point of depending on it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the revision is a trigger, not a read
  useEffect(() => {
    let live = true;
    void window.aibuildos
      .invoke("project:changes", { id: projectId })
      .then((next) => {
        if (live) setChanges(next);
      })
      .catch(() => {
        if (live)
          setChanges({
            staged: [],
            unstaged: [],
            untracked: [],
            commits: [],
            problem: "Git could not be read.",
          });
      });
    return () => {
      live = false;
    };
  }, [projectId, revision]);

  // Staging or unstaging one path, then bumping the shared revision so this rail and every other
  // reader of the working tree (the file tree's amber marks, the review tab) re-read together.
  const stage = useCallback(
    async (path: string) => {
      await window.aibuildos.invoke("project:stage", { id: projectId, path });
      bump();
    },
    [projectId, bump],
  );
  const unstage = useCallback(
    async (path: string) => {
      await window.aibuildos.invoke("project:unstage", { id: projectId, path });
      bump();
    },
    [projectId, bump],
  );

  if (changes === null) return <Loading className="px-3 py-2 text-xs" />;
  if (changes.problem) {
    return (
      <p data-testid="changes-problem" className="px-3 py-2 text-xs text-red-600">
        {changes.problem}
      </p>
    );
  }

  const clean =
    changes.staged.length === 0 && changes.unstaged.length === 0 && changes.untracked.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-auto py-1.5">
        {clean ? (
          <p data-testid="changes-clean" className="px-3 py-1 text-xs text-neutral-500">
            Working tree clean.
          </p>
        ) : (
          <>
            <Group
              label="Staged"
              entries={changes.staged}
              onOpen={onOpen}
              action="unstage"
              onAction={(path) => void unstage(path)}
            />
            <Group
              label="Unstaged"
              entries={changes.unstaged}
              onOpen={onOpen}
              action="stage"
              onAction={(path) => void stage(path)}
            />
            <Group
              label="Untracked"
              entries={changes.untracked}
              onOpen={onOpen}
              action="stage"
              onAction={(path) => void stage(path)}
            />
          </>
        )}

        <CommitBar projectId={projectId} stagedCount={changes.staged.length} />

        <p
          className={`mt-2 border-t border-neutral-200 px-3 pt-2 pb-0.5 dark:border-neutral-800 ${eyebrow}`}
        >
          History
        </p>
        {changes.commits.map((commit) => (
          <div key={commit.hash} className="flex items-baseline gap-2 px-3 py-0.5">
            <span className={`shrink-0 text-[11px] text-neutral-500 ${mono}`}>{commit.hash}</span>
            <span className="min-w-0 flex-1 truncate text-[11px]">{commit.subject}</span>
            <span className={`shrink-0 text-[10px] text-neutral-500 ${mono}`}>
              {relativeTime(commit.date)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Group({
  label,
  entries,
  onOpen,
  action,
  onAction,
}: {
  label: string;
  entries: { path: string; status: string }[];
  onOpen: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  /** What the row's affordance does — stage a change onto the index, or take it back off. */
  action: "stage" | "unstage";
  onAction: (path: string) => void;
}): React.JSX.Element | null {
  if (entries.length === 0) return null;

  return (
    <>
      <p className={`px-3 pt-1.5 pb-0.5 ${eyebrow}`}>
        {label} · {entries.length}
      </p>
      {entries.map((entry) => (
        <div
          key={entry.path}
          className="flex items-center gap-1 pr-2 hover:bg-neutral-50 dark:hover:bg-neutral-900"
        >
          <button
            type="button"
            data-testid="change-row"
            onClick={() =>
              onOpen(
                {
                  id: `diff:${entry.path}`,
                  kind: "diff",
                  title: entry.path.split("/").pop() ?? entry.path,
                },
                { preview: true },
              )
            }
            className={`flex min-w-0 flex-1 items-baseline gap-2 py-0.5 pl-3 text-left ${focusRing}`}
          >
            <span className={`w-2.5 shrink-0 text-[11px] text-amber-600 ${mono}`}>
              {entry.status}
            </span>
            <span className={`min-w-0 flex-1 truncate text-xs ${mono}`} title={entry.path}>
              {entry.path}
            </span>
          </button>
          <button
            type="button"
            data-testid={action === "stage" ? "stage-row" : "unstage-row"}
            onClick={() => onAction(entry.path)}
            className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-200 hover:text-neutral-900 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 ${focusRing}`}
          >
            {action === "stage" ? "Stage" : "Unstage"}
          </button>
        </div>
      ))}
    </>
  );
}

/**
 * The message field and Commit button (RQ-0018#AC-2). Sits right under the staged list — the only
 * one of the three groups a commit actually reads from.
 */
function CommitBar({
  projectId,
  stagedCount,
}: {
  projectId: string;
  stagedCount: number;
}): React.JSX.Element {
  const bump = useBump();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const commit = useCallback(async () => {
    setBusy(true);
    setProblem(null);
    try {
      const result = await window.aibuildos.invoke("project:commit", {
        id: projectId,
        message: message.trim(),
      });
      if (!result.ok) {
        setProblem(result.message);
        return;
      }
      setMessage("");
      bump();
    } finally {
      setBusy(false);
    }
  }, [projectId, message, bump]);

  return (
    <div className="mt-2 border-t border-neutral-200 px-3 pt-2 pb-1.5 dark:border-neutral-800">
      {problem !== null && (
        <p data-testid="commit-problem" className="mb-1.5 whitespace-pre-wrap text-xs text-red-600">
          {problem}
        </p>
      )}
      <div className="flex gap-1.5">
        <input
          data-testid="commit-message"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Commit message"
          className={`${field} text-xs`}
        />
        <button
          type="button"
          data-testid="commit-button"
          disabled={busy || stagedCount === 0 || message.trim() === ""}
          onClick={() => void commit()}
          className={`${primary} shrink-0 py-1 text-xs ${focusRing}`}
        >
          Commit
        </button>
      </div>
    </div>
  );
}

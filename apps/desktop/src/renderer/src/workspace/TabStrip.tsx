import { FileCode2, LayoutGrid, MessageSquare, X } from "lucide-react";
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { getNowBadge, subscribeNowBadge } from "../now/badge.js";
import { eyebrow, focusRing, mono } from "../ui.js";

/**
 * The centre's tab strip (ST-0011#AC-3 to AC-5).
 *
 * Everything opened from either rail opens here, beside the conversation — which is what lets the
 * workspace hold an editor without a fourth panel, and keeps the conversation one click away from
 * whatever is being edited.
 */
export type TabKind =
  | "chat"
  | "board"
  | "now"
  | "session"
  | "file"
  | "artifact"
  | "diff"
  | "plan"
  | "review";

export interface Tab {
  /** Stable across opens of the same thing, so opening it twice focuses rather than duplicates. */
  readonly id: string;
  readonly kind: TabKind;
  readonly title: string;
  /** A preview tab is replaced by the next preview; a pinned one is not (VS Code's rule). */
  readonly preview: boolean;
  /** Unsaved edits. Closing one asks first (RQ-0005#AC-2). */
  readonly dirty?: boolean;
}

const CHAT: Tab = { id: "chat", kind: "chat", title: "Chat", preview: false };
/** Pinned beside Chat (ST-0024#AC-1): the record's shape, not one artifact at a time. */
const BOARD: Tab = { id: "board", kind: "board", title: "Board", preview: false };
/** Pinned beside Board (RQ-0021#AC-2): the work's motion, and what waits on a person. */
const NOW: Tab = { id: "now", kind: "now", title: "Now", preview: false };
/** No pinned tab can be closed. */
const PINNED = new Set([CHAT.id, BOARD.id, NOW.id]);

export interface Tabs {
  tabs: Tab[];
  active: string;
  activeTab: Tab | undefined;
  open: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
}

export function useTabs(): Tabs {
  const [tabs, setTabs] = useState<Tab[]>([CHAT, BOARD, NOW]);
  const [active, setActive] = useState<string>(CHAT.id);
  // Read by `close`, which must not depend on the tab list and be rebuilt on every change.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const open = useCallback<Tabs["open"]>((tab, options) => {
    const preview = options?.preview ?? true;

    setTabs((current) => {
      const existing = current.find((candidate) => candidate.id === tab.id);
      // Opening the same thing twice focuses what is already there. A second tab for one file is
      // how a workspace ends up with thirty of them.
      if (existing) {
        return preview
          ? current
          : current.map((c) => (c.id === tab.id ? { ...c, preview: false } : c));
      }

      const withoutPreview = preview ? current.filter((candidate) => !candidate.preview) : current;
      return [...withoutPreview, { ...tab, preview }];
    });
    setActive(tab.id);
  }, []);

  const close = useCallback((id: string) => {
    // Neither pinned tab has a close control, and nothing else may close them either.
    if (PINNED.has(id)) return;

    // Asked *before* updating, never inside the updater: a state updater must be pure, and React
    // may call it more than once — which would ask twice for one click.
    const going = tabsRef.current.find((tab) => tab.id === id);
    if (going?.dirty === true && !window.confirm(`Discard unsaved changes to ${going.title}?`)) {
      return;
    }

    setTabs((current) => current.filter((tab) => tab.id !== id));
    setActive((current) => (current === id ? CHAT.id : current));
  }, []);

  const setDirty = useCallback((id: string, dirty: boolean) => {
    setTabs((current) =>
      current.map((tab) => (tab.id === id && tab.dirty !== dirty ? { ...tab, dirty } : tab)),
    );
  }, []);

  return {
    tabs,
    active,
    activeTab: tabs.find((tab) => tab.id === active),
    open,
    close,
    focus: setActive,
    setDirty,
  };
}

export function TabStrip({ tabs, active, close, focus }: Tabs): React.JSX.Element {
  const open = tabs.filter((tab) => !PINNED.has(tab.id)).length;
  // The Now tab's needs-you count (RQ-0021#AC-3, ST-0038#AC-2): NowTab is the only thing that knows
  // it, and this label is drawn outside NowTab's own subtree — `now/badge.ts` is the bridge.
  const needsYou = useSyncExternalStore(subscribeNowBadge, getNowBadge);
  return (
    <div
      data-testid="tab-strip"
      className="flex h-[34px] shrink-0 items-stretch border-b border-neutral-200 dark:border-neutral-800"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <div
            key={tab.id}
            data-testid={`tab-${tab.id}`}
            data-active={selected}
            className={`flex items-center gap-2 border-r border-neutral-200 pr-2 pl-3 text-xs dark:border-neutral-800 ${
              selected
                ? "font-medium shadow-[inset_0_-2px_0_currentColor]"
                : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
            }`}
          >
            <button
              type="button"
              onClick={() => focus(tab.id)}
              onDoubleClick={() => focus(tab.id)}
              className={`flex items-center gap-2 py-2 ${focusRing} ${tab.preview ? "italic" : ""}`}
            >
              {tab.kind === "chat" ? (
                <MessageSquare size={12} aria-hidden />
              ) : tab.kind === "board" ? (
                <LayoutGrid size={12} aria-hidden />
              ) : (
                <FileCode2 size={12} aria-hidden />
              )}
              <span className={tab.kind === "chat" || tab.kind === "board" ? "" : mono}>
                {tab.title}
              </span>
              {tab.kind === "now" && needsYou > 0 && (
                <span
                  data-testid="now-badge"
                  className="rounded-full bg-amber-500 px-1.5 text-[10px] font-medium text-white"
                >
                  {needsYou} needs you
                </span>
              )}
              {tab.dirty === true && (
                <span
                  data-testid={`tab-dirty-${tab.id}`}
                  role="img"
                  aria-label="unsaved"
                  className="h-1.5 w-1.5 rounded-full bg-neutral-500"
                />
              )}
            </button>

            {!PINNED.has(tab.id) && (
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                data-testid={`tab-close-${tab.id}`}
                onClick={() => close(tab.id)}
                className={`rounded p-0.5 text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 ${focusRing}`}
              >
                <X size={11} aria-hidden />
              </button>
            )}
          </div>
        );
      })}
      <div className="flex-1" />
      <div className="flex items-center pr-3">
        <span className={eyebrow}>{open === 0 ? "" : `${open} open`}</span>
      </div>
    </div>
  );
}

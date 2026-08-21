import * as Dialog from "@radix-ui/react-dialog";
import {
  Eye,
  FileCode2,
  FileDiff,
  KanbanSquare,
  ListChecks,
  MessageSquare,
  Radio,
  X,
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useBusySessionStream, useBusySessions, useMainStreaming } from "../dock/motion.js";
import { button, eyebrow, focusRing, mono, primary } from "../ui.js";

/**
 * The centre's tab strip (ST-0011#AC-3 to AC-5).
 *
 * Everything opened from either rail opens here, beside the conversation — which is what lets the
 * workspace hold an editor without a fourth panel, and keeps the conversation one click away from
 * whatever is being edited.
 */
export type TabKind =
  | "chat"
  | "plan"
  | "work"
  | "session"
  | "file"
  | "artifact"
  | "diff"
  | "review";

/** One icon per kind that says what it is (RQ-0029#AC-4) — `file`/`artifact` share the plain file
 * glyph they always had; nothing about *those* two was the finding. */
const TAB_ICON: Record<TabKind, typeof MessageSquare> = {
  chat: MessageSquare,
  plan: ListChecks,
  work: KanbanSquare,
  session: Radio,
  review: Eye,
  diff: FileDiff,
  file: FileCode2,
  artifact: FileCode2,
};

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
/** Pinned beside Chat (RQ-0045#AC-1): drafted work, browsed rather than banner-announced. */
const PLAN: Tab = { id: "plan", kind: "plan", title: "Plan", preview: false };
/** Pinned beside Plan (RQ-0045#AC-1, AC-3): the board plus the sprint header. */
const WORK: Tab = { id: "work", kind: "work", title: "Work", preview: false };
/** No pinned tab can be closed. */
const PINNED = new Set([CHAT.id, PLAN.id, WORK.id]);

export interface Tabs {
  tabs: Tab[];
  active: string;
  activeTab: Tab | undefined;
  open: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
  setDirty: (id: string, dirty: boolean) => void;
  /** The dirty tab a close is waiting on an answer for — drawn as the application's own dialog
   * (RQ-0029#AC-3), never `window.confirm`. `null` when nothing is being asked. */
  discarding: Tab | null;
  confirmDiscard: () => void;
  cancelDiscard: () => void;
}

export function useTabs(): Tabs {
  const [tabs, setTabs] = useState<Tab[]>([CHAT, PLAN, WORK]);
  const [active, setActive] = useState<string>(CHAT.id);
  const [discarding, setDiscarding] = useState<Tab | null>(null);
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

  // The actual removal, once nothing more needs asking — either `close` found the tab clean, or the
  // dialog below just confirmed it.
  const removeNow = useCallback((id: string) => {
    setTabs((current) => current.filter((tab) => tab.id !== id));
    setActive((current) => (current === id ? CHAT.id : current));
  }, []);

  const close = useCallback(
    (id: string) => {
      // Neither pinned tab has a close control, and nothing else may close them either.
      if (PINNED.has(id)) return;

      const going = tabsRef.current.find((tab) => tab.id === id);
      if (going?.dirty === true) {
        setDiscarding(going);
        return;
      }
      removeNow(id);
    },
    [removeNow],
  );

  const confirmDiscard = useCallback(() => {
    setDiscarding((current) => {
      if (current !== null) removeNow(current.id);
      return null;
    });
  }, [removeNow]);

  const cancelDiscard = useCallback(() => setDiscarding(null), []);

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
    discarding,
    confirmDiscard,
    cancelDiscard,
  };
}

export function TabStrip({
  tabs,
  active,
  close,
  focus,
  discarding,
  confirmDiscard,
  cancelDiscard,
}: Tabs): React.JSX.Element {
  const open = tabs.filter((tab) => !PINNED.has(tab.id)).length;
  // Work in motion (RQ-0030#AC-1): the MAIN session's streaming flag, and which session tabs are
  // busy right now — both live in `dock/motion.ts`. The needs-you rollup itself moved to the activity
  // dock's own collapsed strip (DC-0027) — this strip no longer carries it.
  const streaming = useMainStreaming();
  const busySessions = useBusySessions();
  useBusySessionStream();

  return (
    <div
      data-testid="tab-strip"
      className="flex h-[34px] shrink-0 items-stretch border-b border-neutral-200 dark:border-neutral-800"
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        const Icon = TAB_ICON[tab.kind];
        const sessionId = tab.kind === "session" ? tab.id.replace(/^session:/, "") : null;
        const working =
          tab.kind === "chat" ? streaming : sessionId !== null && busySessions.has(sessionId);
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
              <Icon size={12} aria-hidden />
              <span className={tab.kind === "chat" || tab.kind === "work" ? "" : mono}>
                {tab.title}
              </span>
              {/* A word and a quiet pulse, never colour alone (RQ-0030#AC-1). */}
              {working && (
                <span
                  data-testid={`tab-working-${tab.id}`}
                  className="flex items-center gap-1 text-[10px] text-neutral-500"
                >
                  <span
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400"
                    aria-hidden
                  />
                  working…
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

      {/* The application's own dialog (RQ-0029#AC-3), the `NewProjectDialog` idiom: Radix, styled
          for both appearances, in place of `window.confirm` blocking the renderer in the platform's
          own chrome. */}
      <Dialog.Root
        open={discarding !== null}
        onOpenChange={(next) => {
          if (!next) cancelDiscard();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40" />
          <Dialog.Content
            data-testid="discard-dialog"
            className="fixed top-1/2 left-1/2 w-[26rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-neutral-200 bg-white p-6 shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
          >
            <Dialog.Title className="text-lg font-semibold tracking-tight">
              Discard unsaved changes?
            </Dialog.Title>
            <Dialog.Description className="mt-1 mb-4 text-sm text-neutral-500">
              {discarding?.title ?? "This tab"} has changes that have not been saved. Closing it now
              throws them away.
            </Dialog.Description>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-testid="discard-cancel"
                onClick={cancelDiscard}
                className={`${button} ${focusRing}`}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="discard-confirm"
                onClick={confirmDiscard}
                className={`${primary} ${focusRing}`}
              >
                Discard
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

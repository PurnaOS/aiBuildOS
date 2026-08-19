import { FileCode2, MessageSquare, X } from "lucide-react";
import { useCallback, useState } from "react";
import { eyebrow, focusRing, mono } from "../ui.js";

/**
 * The centre's tab strip (ST-0011#AC-3 to AC-5).
 *
 * Everything opened from either rail opens here, beside the conversation — which is what lets the
 * workspace hold an editor without a fourth panel, and keeps the conversation one click away from
 * whatever is being edited.
 */
export type TabKind = "chat" | "file" | "artifact" | "diff";

export interface Tab {
  /** Stable across opens of the same thing, so opening it twice focuses rather than duplicates. */
  readonly id: string;
  readonly kind: TabKind;
  readonly title: string;
  /** A preview tab is replaced by the next preview; a pinned one is not (VS Code's rule). */
  readonly preview: boolean;
}

const CHAT: Tab = { id: "chat", kind: "chat", title: "Chat", preview: false };

export interface Tabs {
  tabs: Tab[];
  active: string;
  activeTab: Tab | undefined;
  open: (tab: Omit<Tab, "preview">, options?: { preview?: boolean }) => void;
  close: (id: string) => void;
  focus: (id: string) => void;
}

export function useTabs(): Tabs {
  const [tabs, setTabs] = useState<Tab[]>([CHAT]);
  const [active, setActive] = useState<string>(CHAT.id);

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
    // The conversation has no close control, and nothing else may close it either.
    if (id === CHAT.id) return;

    setTabs((current) => current.filter((tab) => tab.id !== id));
    setActive((current) => (current === id ? CHAT.id : current));
  }, []);

  return {
    tabs,
    active,
    activeTab: tabs.find((tab) => tab.id === active),
    open,
    close,
    focus: setActive,
  };
}

export function TabStrip({ tabs, active, close, focus }: Tabs): React.JSX.Element {
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
              ) : (
                <FileCode2 size={12} aria-hidden />
              )}
              <span className={tab.kind === "chat" ? "" : mono}>{tab.title}</span>
            </button>

            {tab.id !== CHAT.id && (
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
        <span className={eyebrow}>{tabs.length - 1 === 0 ? "" : `${tabs.length - 1} open`}</span>
      </div>
    </div>
  );
}

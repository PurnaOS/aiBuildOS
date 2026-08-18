import type { ChannelResponse } from "@aibuildos/ipc";
import { useEffect, useState } from "react";
import { useUiStore } from "./state/ui-store.js";

/**
 * The shell. It renders, it proves the IPC boundary is wired, and it does nothing else — the
 * bootstrap deliberately ships no product behaviour.
 */
export function App(): React.JSX.Element {
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const [info, setInfo] = useState<ChannelResponse<"app:info"> | null>(null);

  useEffect(() => {
    void window.aibuildos.invoke("app:info", undefined).then(setInfo);
  }, []);

  return (
    <div className="flex h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {sidebarOpen && (
        <aside
          data-testid="sidebar"
          className="w-56 shrink-0 border-r border-neutral-200 p-4 text-sm dark:border-neutral-800"
        >
          <p className="font-medium">aiBuildOS</p>
        </aside>
      )}

      <main className="flex flex-1 flex-col items-start gap-4 p-8">
        <h1 data-testid="title" className="text-xl font-semibold tracking-tight">
          aiBuildOS
        </h1>

        <dl data-testid="runtime" className="text-sm tabular-nums">
          <div className="flex gap-2">
            <dt className="text-neutral-500">node</dt>
            <dd>{info?.runtime.node ?? "…"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-neutral-500">electron</dt>
            <dd>{info?.runtime.electron ?? "…"}</dd>
          </div>
        </dl>

        <button
          type="button"
          onClick={toggleSidebar}
          className="rounded border border-neutral-300 px-3 py-1 text-sm dark:border-neutral-700"
        >
          Toggle sidebar
        </button>
      </main>
    </div>
  );
}

import type { ChannelResponse } from "@aibuildos/ipc";
import { useEffect, useState } from "react";
import { AttachHarnessDialog, HarnessPanel, useHarnesses } from "./harness/HarnessPanel.js";
import { useUiStore } from "./state/ui-store.js";

/**
 * The shell: a sidebar, a view, and the first-run prompt to attach a coding harness (RQ-0001).
 */
export function App(): React.JSX.Element {
  const view = useUiStore((state) => state.view);
  const setView = useUiStore((state) => state.setView);
  const [info, setInfo] = useState<ChannelResponse<"app:info"> | null>(null);
  // One owner of the harness list, passed down: see `useHarnesses`.
  const harnessState = useHarnesses();
  const { harnesses, refresh } = harnessState;

  useEffect(() => {
    void window.aibuildos.invoke("app:info", undefined).then(setInfo);
  }, []);

  const navItem = (target: "home" | "settings", label: string): React.JSX.Element => (
    <button
      type="button"
      data-testid={`nav-${target}`}
      onClick={() => setView(target)}
      className={`w-full rounded px-2 py-1 text-left ${
        view === target ? "bg-neutral-100 font-medium dark:bg-neutral-900" : "text-neutral-500"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <aside
        data-testid="sidebar"
        className="flex w-56 shrink-0 flex-col gap-1 border-r border-neutral-200 p-4 text-sm dark:border-neutral-800"
      >
        <p className="mb-2 font-medium">aiBuildOS</p>
        {navItem("home", "Home")}
        {navItem("settings", "Settings")}
      </aside>

      <main className="flex flex-1 flex-col items-start gap-4 overflow-auto p-8">
        <h1 data-testid="title" className="text-xl font-semibold tracking-tight">
          aiBuildOS
        </h1>

        {view === "settings" ? (
          <HarnessPanel {...harnessState} />
        ) : (
          <>
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
          </>
        )}
      </main>

      <AttachHarnessDialog
        open={harnesses !== null && harnesses.length === 0}
        onAttached={() => {
          void refresh();
          setView("settings");
        }}
      />
    </div>
  );
}

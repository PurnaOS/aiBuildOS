import { PanelLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { AppearancePanel } from "./AppearancePanel.js";
import { AttachHarnessDialog, HarnessPanel, useHarnesses } from "./harness/HarnessPanel.js";
import { LaunchPage, type ProjectSummary, useProjects } from "./project/LaunchPage.js";
import { useUiStore } from "./state/ui-store.js";
import { focusRing, mono } from "./ui.js";
import { Workspace } from "./workspace/Workspace.js";

/**
 * The shell: a sidebar, a view, and the first-run prompt to attach a coding harness (RQ-0001).
 *
 * The sidebar is **installation-scoped**, not project-scoped — Settings holds harnesses, which belong
 * to the machine rather than to any one project, so it stays reachable with no project open. What
 * changes with a project open is that the sidebar gains the project's identity and a way to close it,
 * and that `Projects` shows the project instead of the ledger (ST-0004).
 */
export function App(): React.JSX.Element {
  /**
   * Where the sidebar was left (ST-0022#AC-3).
   *
   * `null` until the settings answer, so the sidebar is not drawn in the wrong state and then moved.
   * Kept in the installation's settings rather than the renderer's own storage — which is where it
   * obviously belonged until a probe showed nothing there survives a restart (BG-0004).
   */
  const [collapsed, setCollapsed] = useState<boolean | null>(null);
  const view = useUiStore((state) => state.view);
  const setView = useUiStore((state) => state.setView);
  const activeProjectId = useUiStore((state) => state.activeProjectId);
  const openProject = useUiStore((state) => state.openProject);
  const closeProject = useUiStore((state) => state.closeProject);

  // One owner of each list, passed down: see `useHarnesses` and `useProjects`.
  const harnessState = useHarnesses();
  const { harnesses, refresh } = harnessState;
  const projectState = useProjects();

  useEffect(() => {
    let live = true;
    void window.aibuildos
      .invoke("settings:get", {})
      .then((settings) => {
        if (live) setCollapsed(settings.sidebarCollapsed);
      })
      .catch(() => {
        // Unreadable settings are not worth a sidebar nobody can see.
        if (live) setCollapsed(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const toggleSidebar = useCallback(() => {
    setCollapsed((current) => {
      const next = !(current ?? false);
      void window.aibuildos.invoke("settings:set-chrome", { sidebarCollapsed: next });
      return next;
    });
  }, []);

  // ⌘B, from the menu where the accelerator lives (ST-0022#AC-2).
  useEffect(() => {
    return window.aibuildos.subscribe("app:command", (payload) => {
      if (payload.command === "toggle-sidebar") toggleSidebar();
    });
  }, [toggleSidebar]);

  const navItem = (target: "home" | "settings", label: string): React.JSX.Element => (
    <button
      type="button"
      data-testid={`nav-${target}`}
      onClick={() => setView(target)}
      className={`w-full rounded px-2 py-1 text-left ${focusRing} ${
        view === target ? "bg-neutral-100 font-medium dark:bg-neutral-900" : "text-neutral-500"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {/* Collapsed to nothing, with a handle in its place: an affordance that exists only as a
          keystroke is one most people never find, and this project's own discipline is that a signal
          is never available one way only (ST-0022#AC-1). */}
      {collapsed === true && (
        <button
          type="button"
          data-testid="sidebar-expand"
          aria-label="Show sidebar"
          onClick={toggleSidebar}
          className={`shrink-0 border-r border-neutral-200 px-1.5 text-neutral-500 hover:text-neutral-900 dark:border-neutral-800 dark:hover:text-neutral-100 ${focusRing}`}
        >
          <PanelLeft size={14} aria-hidden />
        </button>
      )}

      <aside
        data-testid="sidebar"
        hidden={collapsed !== false}
        className="flex w-56 shrink-0 flex-col gap-1 border-r border-neutral-200 p-4 text-sm dark:border-neutral-800"
      >
        <div className="mb-1 flex justify-end">
          <button
            type="button"
            data-testid="sidebar-collapse"
            aria-label="Hide sidebar"
            onClick={toggleSidebar}
            className={`text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 ${focusRing}`}
          >
            <PanelLeft size={14} aria-hidden />
          </button>
        </div>
        {activeProjectId === null ? (
          <p className="mb-2 font-medium">aiBuildOS</p>
        ) : (
          <ActiveProject id={activeProjectId} projects={projectState.projects} />
        )}

        {navItem("home", activeProjectId === null ? "Projects" : "Project")}
        {navItem("settings", "Settings")}

        {activeProjectId !== null && (
          <button
            type="button"
            data-testid="project-close"
            onClick={closeProject}
            className={`mt-auto w-full rounded px-2 py-1 text-left text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 ${focusRing}`}
          >
            Close project
          </button>
        )}
      </aside>

      {/* The workspace owns its own full height and lays out its own panes; every other view is a
          page inside the padded column the shell has always used. */}
      {view === "home" && activeProjectId !== null ? (
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 data-testid="title" className="sr-only">
            aiBuildOS
          </h1>
          <Workspace projectId={activeProjectId} />
        </div>
      ) : (
        <main className="flex flex-1 flex-col items-start gap-4 overflow-auto p-8">
          <h1 data-testid="title" className="text-xl font-semibold tracking-tight">
            aiBuildOS
          </h1>

          {view === "settings" ? (
            <div className="flex w-full flex-col gap-8">
              <HarnessPanel {...harnessState} />
              <AppearancePanel />
            </div>
          ) : (
            <LaunchPage {...projectState} onOpen={openProject} />
          )}
        </main>
      )}

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

/**
 * The open project's identity at the top of the sidebar.
 *
 * Reads the list `App` owns rather than fetching its own — the store holds the id and nothing else,
 * so there is no copy of the project's name here to go stale when it changes on disk (DC-0005).
 */
function ActiveProject({
  id,
  projects,
}: {
  id: string;
  projects: ProjectSummary[] | null;
}): React.JSX.Element {
  const project = projects?.find((candidate) => candidate.id === id);

  return (
    <div className="mb-2">
      <p data-testid="active-project" className="truncate font-medium" title={project?.path}>
        {project?.name ?? "…"}
      </p>
      <p className={`truncate text-xs text-neutral-500 ${mono}`}>{project?.branch ?? ""}</p>
    </div>
  );
}

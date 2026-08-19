import { AttachHarnessDialog, HarnessPanel, useHarnesses } from "./harness/HarnessPanel.js";
import { LaunchPage, type ProjectSummary, useProjects } from "./project/LaunchPage.js";
import { ProjectWorkspace } from "./project/ProjectWorkspace.js";
import { useUiStore } from "./state/ui-store.js";
import { focusRing, mono } from "./ui.js";

/**
 * The shell: a sidebar, a view, and the first-run prompt to attach a coding harness (RQ-0001).
 *
 * The sidebar is **installation-scoped**, not project-scoped — Settings holds harnesses, which belong
 * to the machine rather than to any one project, so it stays reachable with no project open. What
 * changes with a project open is that the sidebar gains the project's identity and a way to close it,
 * and that `Projects` shows the project instead of the ledger (ST-0004).
 */
export function App(): React.JSX.Element {
  const view = useUiStore((state) => state.view);
  const setView = useUiStore((state) => state.setView);
  const activeProjectId = useUiStore((state) => state.activeProjectId);
  const openProject = useUiStore((state) => state.openProject);
  const closeProject = useUiStore((state) => state.closeProject);

  // One owner of each list, passed down: see `useHarnesses` and `useProjects`.
  const harnessState = useHarnesses();
  const { harnesses, refresh } = harnessState;
  const projectState = useProjects();

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
      <aside
        data-testid="sidebar"
        className="flex w-56 shrink-0 flex-col gap-1 border-r border-neutral-200 p-4 text-sm dark:border-neutral-800"
      >
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

      <main className="flex flex-1 flex-col items-start gap-4 overflow-auto p-8">
        <h1 data-testid="title" className="text-xl font-semibold tracking-tight">
          aiBuildOS
        </h1>

        {view === "settings" ? (
          <HarnessPanel {...harnessState} />
        ) : activeProjectId === null ? (
          <LaunchPage {...projectState} onOpen={openProject} />
        ) : (
          <ProjectWorkspace id={activeProjectId} onRefreshed={projectState.refresh} />
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

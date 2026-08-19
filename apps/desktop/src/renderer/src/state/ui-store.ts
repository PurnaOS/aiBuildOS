import { create } from "zustand";

/**
 * The one and only Zustand store, and it holds **UI state only** (DC-0005).
 *
 * Domain state — the OKF graph, the harness list, the project list, agent sessions, Git status — is
 * owned by the main process and read across IPC at the point of use. It is never mirrored here. A
 * second store is a smell, not a pattern: it means that boundary was crossed.
 *
 * `activeProjectId` belongs here because *which* project is on screen is a fact about the window, not
 * about the project. Everything the project itself knows is read from main.
 */
export type View = "home" | "settings";

export interface UiState {
  view: View;
  setView: (view: View) => void;
  /** `null` shows the launch page. There is at most one project open at a time (EP-0002). */
  activeProjectId: string | null;
  openProject: (id: string) => void;
  closeProject: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "home",
  setView: (view) => set({ view }),
  activeProjectId: null,
  // Opening always lands on the project view, whatever was selected last time.
  openProject: (id) => set({ activeProjectId: id, view: "home" }),
  closeProject: () => set({ activeProjectId: null, view: "home" }),
}));

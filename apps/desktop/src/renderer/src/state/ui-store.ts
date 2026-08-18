import { create } from "zustand";

/**
 * The one and only Zustand store, and it holds **UI state only** (DC-0005).
 *
 * Domain state — the OKF graph, the harness list, agent sessions, Git status — is owned by the main
 * process and read across IPC at the point of use. It is never mirrored here. A second store is a
 * smell, not a pattern: it means that boundary was crossed.
 */
export type View = "home" | "settings";

export interface UiState {
  view: View;
  setView: (view: View) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "home",
  setView: (view) => set({ view }),
}));

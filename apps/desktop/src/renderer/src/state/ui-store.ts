import { create } from "zustand";

/**
 * The one and only Zustand store, and it holds **UI state only** (DC-0005).
 *
 * Domain state — the OKF graph, agent sessions, Git status — is owned by the main process and read
 * across IPC at the point of use. It is never mirrored here. A second store is a smell, not a
 * pattern: it means that boundary was crossed.
 */
export interface UiState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// Remembers the desktop tasks board's right-hand agent panel width so the size
// the user dragged it to survives a reload / navigating away and back. Only the
// width is durable; everything else about the board is derived at render time.

interface TasksBoardUiState {
  /** Open width (in px) of the right-hand agent side panel. */
  panelWidth: number;
  setPanelWidth: (panelWidth: number) => void;
}

// Mirrors DEFAULT_PANEL_WIDTH in tasks-screen.tsx — the width a fresh install
// opens the panel at before the user has resized it.
const DEFAULT_PANEL_WIDTH = 440;

export const useTasksBoardUiStore = create<TasksBoardUiState>()(
  persist(
    (set) => ({
      panelWidth: DEFAULT_PANEL_WIDTH,
      setPanelWidth: (panelWidth) => set({ panelWidth }),
    }),
    {
      name: "tasks-board-ui",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

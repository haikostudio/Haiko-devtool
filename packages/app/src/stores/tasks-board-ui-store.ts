import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

// Remembers the desktop tasks board's right-hand agent panel width so the size
// the user dragged it to survives a reload / navigating away and back. Only the
// width is durable; everything else about the board is derived at render time.

interface TasksBoardUiState {
  /** Open width (in px) of the right-hand Details/Billing drawer. */
  panelWidth: number;
  setPanelWidth: (panelWidth: number) => void;
  /** Whether the bottom-docked "Chef d'orchestre" chat dock is open. */
  conductorOpen: boolean;
  setConductorOpen: (conductorOpen: boolean) => void;
  /** Height (in px) of the conductor chat dock. */
  conductorHeight: number;
  setConductorHeight: (conductorHeight: number) => void;
  /** Horizontal offset (in px) of the conductor dock from its centered position. */
  conductorOffsetX: number;
  setConductorOffsetX: (conductorOffsetX: number) => void;
  /** Whether the conductor chat dock is collapsed to its title bar. */
  conductorCollapsed: boolean;
  setConductorCollapsed: (conductorCollapsed: boolean) => void;
  /** Height (in px) of the Details/Billing dock. */
  detailsHeight: number;
  setDetailsHeight: (detailsHeight: number) => void;
  /** Horizontal offset (in px) of the Details/Billing dock from its centered position. */
  detailsOffsetX: number;
  setDetailsOffsetX: (detailsOffsetX: number) => void;
  /** Whether the Details/Billing dock is collapsed to its title bar. */
  detailsCollapsed: boolean;
  setDetailsCollapsed: (detailsCollapsed: boolean) => void;
  /**
   * Ephemeral (not persisted): the task whose agent chat the bottom dock shows.
   * `null` means the dock shows the persistent conductor agent. Set on task tap,
   * cleared by the dock's "back to conductor" control.
   */
  dockTaskId: string | null;
  setDockTaskId: (dockTaskId: string | null) => void;
  /**
   * Ephemeral (not persisted): the task whose Details+Billing drawer is open
   * (desktop right panel or the compact full-screen sheet). `null` means closed.
   * Opened by the dock header's "Details" button, independent of `dockTaskId`.
   */
  detailsTaskId: string | null;
  setDetailsTaskId: (detailsTaskId: string | null) => void;
}

// Mirrors DEFAULT_PANEL_WIDTH in tasks-screen.tsx — the width a fresh install
// opens the panel at before the user has resized it.
const DEFAULT_PANEL_WIDTH = 440;
const DEFAULT_CONDUCTOR_HEIGHT = 340;

export const useTasksBoardUiStore = create<TasksBoardUiState>()(
  persist(
    (set) => ({
      panelWidth: DEFAULT_PANEL_WIDTH,
      setPanelWidth: (panelWidth) => set({ panelWidth }),
      conductorOpen: false,
      setConductorOpen: (conductorOpen) => set({ conductorOpen }),
      conductorHeight: DEFAULT_CONDUCTOR_HEIGHT,
      setConductorHeight: (conductorHeight) => set({ conductorHeight }),
      conductorOffsetX: 0,
      setConductorOffsetX: (conductorOffsetX) => set({ conductorOffsetX }),
      conductorCollapsed: false,
      setConductorCollapsed: (conductorCollapsed) => set({ conductorCollapsed }),
      detailsHeight: DEFAULT_CONDUCTOR_HEIGHT,
      setDetailsHeight: (detailsHeight) => set({ detailsHeight }),
      detailsOffsetX: 0,
      setDetailsOffsetX: (detailsOffsetX) => set({ detailsOffsetX }),
      detailsCollapsed: false,
      setDetailsCollapsed: (detailsCollapsed) => set({ detailsCollapsed }),
      dockTaskId: null,
      setDockTaskId: (dockTaskId) => set({ dockTaskId }),
      detailsTaskId: null,
      setDetailsTaskId: (detailsTaskId) => set({ detailsTaskId }),
    }),
    {
      name: "tasks-board-ui",
      storage: createJSONStorage(() => AsyncStorage),
      // Only layout preferences survive a reload — the ephemeral task selection
      // (which chat the dock shows, which drawer is open) must always start empty.
      partialize: (state) => ({
        panelWidth: state.panelWidth,
        conductorOpen: state.conductorOpen,
        conductorHeight: state.conductorHeight,
        conductorOffsetX: state.conductorOffsetX,
        conductorCollapsed: state.conductorCollapsed,
        detailsHeight: state.detailsHeight,
        detailsOffsetX: state.detailsOffsetX,
        detailsCollapsed: state.detailsCollapsed,
      }),
    },
  ),
);

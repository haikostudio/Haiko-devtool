import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { DEFAULT_EXPLORER_SIDEBAR_WIDTH } from "@/stores/panel-store";

// Remembers the desktop tasks board's right-hand agent panel width so the size
// the user dragged it to survives a reload / navigating away and back. Only the
// width is durable; everything else about the board is derived at render time.

/**
 * Which agent the "Chef d'orchestre" runs on. The provider of a LIVE agent can
 * never be changed from the composer's native model menu (that menu only lists
 * the running agent's own provider), so the Claude/Codex choice has to be made
 * where the conductor agent is created — here, remembered across reloads.
 */
export type ConductorProviderChoice = "claude/sonnet" | "codex/gpt-5.4";

interface TasksBoardUiState {
  /** Open width (in px) of the right-hand Details/Billing drawer. */
  panelWidth: number;
  setPanelWidth: (panelWidth: number) => void;
  /** Provider the conductor chat runs on (one persisted conductor per provider). */
  conductorProvider: ConductorProviderChoice;
  setConductorProvider: (conductorProvider: ConductorProviderChoice) => void;
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
  /** Height (in px) of the always-visible timeline + quota area above the board. */
  timelineHeight: number;
  setTimelineHeight: (timelineHeight: number) => void;
  /** Whether the project file explorer panel is open. */
  explorerOpen: boolean;
  setExplorerOpen: (explorerOpen: boolean) => void;
  /**
   * Width (in px) of the desktop explorer side panel. The panel splits the row
   * with the board instead of floating over it, so this width is what the board
   * gives up — remembered across reloads like every other panel size.
   */
  explorerWidth: number;
  setExplorerWidth: (explorerWidth: number) => void;
  /** Height (in px) of the compact file explorer dock. */
  explorerHeight: number;
  setExplorerHeight: (explorerHeight: number) => void;
  /** Horizontal offset (in px) of the compact explorer dock from its centered position. */
  explorerOffsetX: number;
  setExplorerOffsetX: (explorerOffsetX: number) => void;
  /** Whether the compact explorer dock is collapsed to its title bar. */
  explorerCollapsed: boolean;
  setExplorerCollapsed: (explorerCollapsed: boolean) => void;
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
// Claude by default, matching the daemon's own conductor default.
const DEFAULT_CONDUCTOR_PROVIDER: ConductorProviderChoice = "claude/sonnet";
// Mirrors DEFAULT_TIMELINE_HEIGHT in task-timeline-area.tsx.
const DEFAULT_TIMELINE_HEIGHT = 190;

export const useTasksBoardUiStore = create<TasksBoardUiState>()(
  persist(
    (set) => ({
      panelWidth: DEFAULT_PANEL_WIDTH,
      setPanelWidth: (panelWidth) => set({ panelWidth }),
      conductorProvider: DEFAULT_CONDUCTOR_PROVIDER,
      setConductorProvider: (conductorProvider) => set({ conductorProvider }),
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
      timelineHeight: DEFAULT_TIMELINE_HEIGHT,
      setTimelineHeight: (timelineHeight) => set({ timelineHeight }),
      explorerOpen: false,
      setExplorerOpen: (explorerOpen) => set({ explorerOpen }),
      explorerWidth: DEFAULT_EXPLORER_SIDEBAR_WIDTH,
      setExplorerWidth: (explorerWidth) => set({ explorerWidth }),
      explorerHeight: DEFAULT_CONDUCTOR_HEIGHT,
      setExplorerHeight: (explorerHeight) => set({ explorerHeight }),
      explorerOffsetX: 0,
      setExplorerOffsetX: (explorerOffsetX) => set({ explorerOffsetX }),
      explorerCollapsed: false,
      setExplorerCollapsed: (explorerCollapsed) => set({ explorerCollapsed }),
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
        conductorProvider: state.conductorProvider,
        conductorOpen: state.conductorOpen,
        conductorHeight: state.conductorHeight,
        conductorOffsetX: state.conductorOffsetX,
        conductorCollapsed: state.conductorCollapsed,
        detailsHeight: state.detailsHeight,
        detailsOffsetX: state.detailsOffsetX,
        detailsCollapsed: state.detailsCollapsed,
        timelineHeight: state.timelineHeight,
        explorerOpen: state.explorerOpen,
        explorerWidth: state.explorerWidth,
        explorerHeight: state.explorerHeight,
        explorerOffsetX: state.explorerOffsetX,
        explorerCollapsed: state.explorerCollapsed,
      }),
    },
  ),
);

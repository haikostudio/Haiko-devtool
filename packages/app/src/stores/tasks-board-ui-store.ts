import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { DEFAULT_EXPLORER_SIDEBAR_WIDTH } from "@/stores/panel-store";
import { FILE_PREVIEW_WIDTH_UNSET } from "@/components/tasks/task-file-preview-layout";

// Remembers the desktop tasks board's right-hand agent panel width so the size
// the user dragged it to survives a reload / navigating away and back. Only the
// width is durable; everything else about the board is derived at render time.

/**
 * Which agent the "Chef d'orchestre" runs on. The provider of a LIVE agent can
 * never be changed from the composer's native model menu (that menu only lists
 * the running agent's own provider), so the Claude/Codex choice has to be made
 * where the conductor agent is created — here, remembered across reloads.
 */
export type ConductorProviderChoice = "claude/claude-opus-4-8" | "codex/gpt-5.4";

interface TasksBoardUiState {
  /** Open width (in px) of the right-hand Details/Billing drawer. */
  panelWidth: number;
  setPanelWidth: (panelWidth: number) => void;
  /** Provider the conductor chat runs on (one persisted conductor per provider). */
  conductorProvider: ConductorProviderChoice;
  setConductorProvider: (conductorProvider: ConductorProviderChoice) => void;
  /** Whether the right-hand "Chef d'orchestre" chat side panel is open. */
  conductorOpen: boolean;
  setConductorOpen: (conductorOpen: boolean) => void;
  /**
   * Width (in px) of the desktop conductor/agents side panel. Like the explorer
   * side panel, it splits the row with the board instead of floating over it, so
   * this width is what the board gives up — remembered across reloads.
   */
  conductorPanelWidth: number;
  setConductorPanelWidth: (conductorPanelWidth: number) => void;
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
   * Remembers that the user chose "Publier puis redémarrer" last time, so that
   * choice becomes the highlighted default on the next card that needs a
   * restart. Persisted: it is a habit, not a session state. Only ever a
   * DEFAULT — the plain "Publier" door stays right next to it.
   */
  preferDeployThenRestart: boolean;
  setPreferDeployThenRestart: (preferDeployThenRestart: boolean) => void;
  /**
   * Ephemeral (not persisted): the task whose agent chat the bottom dock shows.
   * `null` means the dock shows the persistent conductor agent. Set on task tap,
   * cleared by the dock's "back to conductor" control.
   */
  dockTaskId: string | null;
  setDockTaskId: (dockTaskId: string | null) => void;
  /**
   * Ephemeral (not persisted): the id of the grouped batch-publication agent
   * whose chat the bottom dock shows. Mutually exclusive with `dockTaskId`.
   *
   * DORMANT since the publication became a plain build script: there is no
   * deploy agent to dock any more, so nothing ever sets this to a non-null value
   * — the banner now opens the publication's LOG (`DeployLogSheet`). Kept
   * (always null) rather than ripped out of the dock's presence rules, which are
   * shared with the task and conductor views. Remove with the dock's deploy
   * branch the next time that file is opened.
   */
  dockDeployAgentId: string | null;
  setDockDeployAgentId: (dockDeployAgentId: string | null) => void;
  /**
   * Ephemeral (not persisted): the task whose Details+Billing drawer is open
   * (desktop right panel or the compact full-screen sheet). `null` means closed.
   * Opened by the dock header's "Details" button, independent of `dockTaskId`.
   */
  detailsTaskId: string | null;
  setDetailsTaskId: (detailsTaskId: string | null) => void;
  /**
   * Ephemeral (not persisted): absolute path of the file the board's preview
   * panel is showing, `null` when the panel is closed. Set by tapping a file in
   * the explorer tree; tapping another file only swaps this path, so the panel
   * stays up and re-reads instead of closing and re-opening.
   */
  previewFilePath: string | null;
  setPreviewFilePath: (previewFilePath: string | null) => void;
  /**
   * Width (in px) the user dragged the desktop file preview overlay to.
   * `FILE_PREVIEW_WIDTH_UNSET` (0) means "never dragged": the panel then opens at
   * half the board area instead of freezing at a width some past viewport made
   * half of. Persisted, like every other panel size.
   */
  previewWidth: number;
  setPreviewWidth: (previewWidth: number) => void;
  /**
   * Ephemeral (not persisted): whether the project's attachments slide-over is
   * open. The paperclip is an action ("show me the files"), not a layout the
   * board should restore on its own at startup.
   */
  attachmentsOpen: boolean;
  setAttachmentsOpen: (attachmentsOpen: boolean) => void;
  /**
   * Ephemeral (not persisted): id of the attachment the panel is previewing,
   * `null` while it shows the list. Closing the panel clears it, so re-opening
   * always lands on the list.
   */
  attachmentsEntryId: string | null;
  setAttachmentsEntryId: (attachmentsEntryId: string | null) => void;
  /**
   * `startedAt` of the finished batch publication whose recap the user closed.
   * Persisted, so a recap dismissed on this device stays closed across reloads;
   * the next publication carries a new `startedAt` and shows again on its own.
   */
  dismissedDeployBatchAt: string | null;
  dismissDeployBatch: (startedAt: string) => void;
}

/**
 * The task the user currently has open — the one whose chat the dock shows, or
 * whose Details drawer is up on hosts without a conductor. Cards read this to
 * wear the "open" outline, so the outline follows the selection and clears
 * itself when either surface closes (both ids are dropped on close).
 *
 * The dock's id only counts while the dock is actually open: a stale id would
 * otherwise keep a card outlined after the dock was dismissed.
 */
export function useOpenTaskId(): string | null {
  return useTasksBoardUiStore((state) =>
    state.conductorOpen ? (state.dockTaskId ?? state.detailsTaskId) : state.detailsTaskId,
  );
}

// Mirrors DEFAULT_PANEL_WIDTH in tasks-screen.tsx — the width a fresh install
// opens the panel at before the user has resized it.
const DEFAULT_PANEL_WIDTH = 440;
const DEFAULT_CONDUCTOR_HEIGHT = 340;
// Opening width of the desktop conductor/agents side panel before the user drags
// it — a touch wider than the file explorer since it hosts a chat, not a tree.
const DEFAULT_CONDUCTOR_PANEL_WIDTH = 440;
// Claude by default, matching the daemon's own conductor default.
const DEFAULT_CONDUCTOR_PROVIDER: ConductorProviderChoice = "claude/claude-opus-4-8";

/**
 * Coerces a persisted provider choice back into the union: Codex stays Codex,
 * anything else lands on the Claude default rather than leaking outside the type.
 *
 * COMPAT(conductorClaudeModel): added in v0.2.3 — the Claude choice used to be
 * the bare "claude/sonnet" alias and is still sitting in every existing install's
 * persisted store, where it would otherwise blank the toggle label. Drop the
 * normalizer when no install can still hold that value.
 */
function normalizeConductorProviderChoice(value: unknown): ConductorProviderChoice {
  return value === "codex/gpt-5.4" ? "codex/gpt-5.4" : DEFAULT_CONDUCTOR_PROVIDER;
}

/**
 * The value to send to the daemon when asking for this conductor. The Claude
 * choice travels as the BARE provider id, never as the full `provider/model`
 * spec: which Claude model the conductor runs on is the daemon's call, and a
 * daemon older than this build rejects outright any spec it does not recognise
 * by name. "claude" is understood by every daemon version and always lands on
 * that daemon's own conductor default.
 */
export function toConductorEnsureProvider(choice: ConductorProviderChoice): string {
  return choice === "codex/gpt-5.4" ? "codex/gpt-5.4" : "claude";
}

export const useTasksBoardUiStore = create<TasksBoardUiState>()(
  persist(
    (set) => ({
      panelWidth: DEFAULT_PANEL_WIDTH,
      setPanelWidth: (panelWidth) => set({ panelWidth }),
      conductorProvider: DEFAULT_CONDUCTOR_PROVIDER,
      setConductorProvider: (conductorProvider) => set({ conductorProvider }),
      conductorOpen: false,
      setConductorOpen: (conductorOpen) => set({ conductorOpen }),
      conductorPanelWidth: DEFAULT_CONDUCTOR_PANEL_WIDTH,
      setConductorPanelWidth: (conductorPanelWidth) => set({ conductorPanelWidth }),
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
      preferDeployThenRestart: false,
      setPreferDeployThenRestart: (preferDeployThenRestart) => set({ preferDeployThenRestart }),
      dockTaskId: null,
      // Selecting a task chat drops the deploy-agent view, and vice versa: the
      // dock shows exactly one of them.
      setDockTaskId: (dockTaskId) =>
        set(dockTaskId ? { dockTaskId, dockDeployAgentId: null } : { dockTaskId }),
      dockDeployAgentId: null,
      setDockDeployAgentId: (dockDeployAgentId) =>
        set(dockDeployAgentId ? { dockDeployAgentId, dockTaskId: null } : { dockDeployAgentId }),
      detailsTaskId: null,
      setDetailsTaskId: (detailsTaskId) => set({ detailsTaskId }),
      previewFilePath: null,
      // The two slide-overs share one stage, so opening a file puts the
      // attachments panel away rather than stacking on top of it.
      setPreviewFilePath: (previewFilePath) =>
        set(previewFilePath ? { previewFilePath, attachmentsOpen: false } : { previewFilePath }),
      previewWidth: FILE_PREVIEW_WIDTH_UNSET,
      setPreviewWidth: (previewWidth) => set({ previewWidth }),
      attachmentsOpen: false,
      // Symmetrically: opening the library puts a file preview away. Closing
      // drops the selection too, so the panel always re-opens on the list.
      setAttachmentsOpen: (attachmentsOpen) =>
        set(
          attachmentsOpen
            ? { attachmentsOpen, previewFilePath: null }
            : { attachmentsOpen, attachmentsEntryId: null },
        ),
      attachmentsEntryId: null,
      setAttachmentsEntryId: (attachmentsEntryId) => set({ attachmentsEntryId }),
      dismissedDeployBatchAt: null,
      dismissDeployBatch: (startedAt) => set({ dismissedDeployBatchAt: startedAt }),
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
        conductorPanelWidth: state.conductorPanelWidth,
        conductorHeight: state.conductorHeight,
        conductorOffsetX: state.conductorOffsetX,
        conductorCollapsed: state.conductorCollapsed,
        detailsHeight: state.detailsHeight,
        detailsOffsetX: state.detailsOffsetX,
        detailsCollapsed: state.detailsCollapsed,
        explorerOpen: state.explorerOpen,
        explorerWidth: state.explorerWidth,
        explorerHeight: state.explorerHeight,
        explorerOffsetX: state.explorerOffsetX,
        explorerCollapsed: state.explorerCollapsed,
        previewWidth: state.previewWidth,
        preferDeployThenRestart: state.preferDeployThenRestart,
        dismissedDeployBatchAt: state.dismissedDeployBatchAt,
      }),
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as Partial<TasksBoardUiState>;
        return {
          ...current,
          ...stored,
          conductorProvider: normalizeConductorProviderChoice(stored.conductorProvider),
        };
      },
    },
  ),
);

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Keyboard, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { RotateCcw, Wand2 } from "lucide-react-native";
import { confirmDialog } from "@/utils/confirm-dialog";
import { TaskBottomDock, type TaskDockHeader } from "@/components/tasks/task-bottom-dock";
import { ComposerFooterControlsProvider } from "@/composer/footer-controls-context";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { resolveConductorDockPresence } from "@/components/tasks/conductor-dock-presence";
import { TaskAgentChat } from "@/components/tasks/task-agent-chat";
import type { RestartProgress } from "@/components/tasks/daemon-restart-progress";
import { TaskBillingView } from "@/components/tasks/task-billing-view";
import {
  TaskDetailInlineForm,
  type TaskDetailSaveInput,
} from "@/components/tasks/task-detail-sheet";
import { isNative } from "@/constants/platform";
import { EvolutionTaskProvider } from "@/contexts/evolution-task-context";
import type { KanbanTask } from "@/data/tasks";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  toConductorEnsureProvider,
  useTasksBoardUiStore,
  type ConductorProviderChoice,
} from "@/stores/tasks-board-ui-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
} from "@/screens/workspace/workspace-pane-content";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedWand = withUnistyles(Wand2);
const ThemedRotate = withUnistyles(RotateCcw);

type EnsureState =
  | { status: "loading" }
  | {
      status: "ready";
      agentId: string;
      workspaceId: string | null;
      provider: ConductorProvider;
    }
  | { status: "error"; message: string };

/** Task-mode tabs, chat first. Details/Billing live here too — no separate drawer. */
type TaskView = "chat" | "details" | "billing";
type ConductorProvider = ConductorProviderChoice;

// Claude vs Codex has to be decided HERE, not in the composer's native model
// menu: that menu only ever lists the running agent's own provider, so once the
// conductor was created on Codex there was no way back to Claude from inside the
// chat. The choice is a creation-time input — the daemon keeps one conductor per
// provider, so switching hands back that provider's own conversation instead of
// destroying anything. The native menu still owns model + thinking level within
// the chosen provider; this control never touches those.
const CONDUCTOR_PROVIDER_LABELS: Record<ConductorProvider, string> = {
  claude: "Claude",
  codex: "Codex",
};

export interface ConductorPanelProps {
  serverId: string | null;
  projectId: string | null;
  /**
   * When set, the dock shows this task's chat + details + billing tabs instead of
   * the persistent conductor agent. `null` = conductor mode.
   */
  dockTask: KanbanTask | null;
  /**
   * When set, the dock shows the grouped batch-publication agent's live chat
   * (opened from the "Publication en cours" banner) instead of the conductor or a
   * task. Mutually exclusive with `dockTask`. `null` = not showing the deploy
   * agent.
   */
  dockDeployAgentId: string | null;
  /** Reset the dock back to the conductor agent (clears the task/deploy chat). */
  onBackToConductor: () => void;
  /** Launch an agent for a task that has none yet (empty-state button). */
  onRunNow: (taskId: string) => void;
  /** Persist edits from the task's Details tab. */
  onSave: (input: TaskDetailSaveInput) => void;
  onDelete: (taskId: string) => void;
  onEstimate: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  /**
   * Validate a backlog ("À faire") card: the user's consent that admits it into
   * the pipeline ("À faire" → "Validé"). Distinct from `onValidate` (the final
   * check). Surfaced as the "Valider la tâche" bar in the task chat.
   */
  onApproveTask: (taskId: string) => void;
  /** User validation of a task: the only path from "En cours" to "Terminée". */
  onValidate: (taskId: string, options?: { queueOnComplete?: boolean }) => void;
  /** Archive (hide) a finished ("Terminé"/"Déployé") card from the board. */
  onArchive: (taskId: string) => void;
  /** Deploy a finished ("Terminé") card: hand its agent a deploy-then-confirm prompt. */
  onDeploy: (taskId: string) => void;
  /** Queue a finished ("Terminé") card into "À déployer" — the button twin of the drag. */
  onQueueDeploy: (taskId: string) => void;
  /**
   * Restart the daemon from a published card whose work only takes effect after
   * a restart. Confirms (and counts the agents it will cut) before firing.
   */
  onRestartDaemon?: (taskId: string) => void;
  /** Takes back a restart while its undo window is still open. */
  onCancelRestartDaemon?: () => void;
  /** Live restart state, so the card's bar can count down to the reconnection. */
  restartProgress?: RestartProgress;
  onSetHold?: (taskId: string, hold: boolean) => void;
  onClose: () => void;
}

/**
 * The "Chef d'orchestre" chat drawer, rendered through the shared
 * `TaskBottomDock`: a bottom sheet on compact, and on desktop a drawer docked to
 * the bottom of the board that the user can drag left/right, resize, and collapse
 * — never a modal floating in the middle of the screen. Shows the persistent
 * per-project conductor agent by default, and swaps to the selected task when a
 * card is tapped on the board. In task mode the body is a three-tab view — Chat
 * (first, live agent), Details and Billing — so everything about a task lives in
 * this one drawer; there is no separate details drawer. Switching agents fully
 * remounts the chat pane (React `key`) so no scroll/terminal state leaks across
 * agents, and the chat tab stays mounted (hidden) so its state survives a hop to
 * Details or Billing and back.
 */
export function ConductorPanel(props: ConductorPanelProps) {
  const { header, body } = useConductorController(props);

  const conductorHeight = useTasksBoardUiStore((state) => state.conductorHeight);
  const conductorOffsetX = useTasksBoardUiStore((state) => state.conductorOffsetX);
  const conductorCollapsed = useTasksBoardUiStore((state) => state.conductorCollapsed);
  const setConductorHeight = useTasksBoardUiStore((state) => state.setConductorHeight);
  const setConductorOffsetX = useTasksBoardUiStore((state) => state.setConductorOffsetX);
  const setConductorCollapsed = useTasksBoardUiStore((state) => state.setConductorCollapsed);
  const handleToggleCollapse = useCallback(
    () => setConductorCollapsed(!conductorCollapsed),
    [conductorCollapsed, setConductorCollapsed],
  );

  return (
    <TaskBottomDock
      header={header}
      visible
      onClose={props.onClose}
      height={conductorHeight}
      offsetX={conductorOffsetX}
      collapsed={conductorCollapsed}
      onResize={setConductorHeight}
      onMove={setConductorOffsetX}
      onToggleCollapse={handleToggleCollapse}
      testID="conductor-panel"
    >
      {body}
    </TaskBottomDock>
  );
}

/**
 * All of the conductor's state and behavior, independent of the shell it renders
 * in. Returns the `header` (title, leading icon, back, provider + reset actions)
 * and the `body` node (loading / error / conductor chat / task tabs) so both the
 * compact bottom dock (`ConductorPanel`) and the desktop right-hand side panel
 * (`ConductorSidePanel`) share one implementation.
 */
export function useConductorController({
  serverId,
  projectId,
  dockTask,
  dockDeployAgentId,
  onBackToConductor,
  onRunNow,
  onSave,
  onDelete,
  onEstimate,
  onApprove,
  onApproveTask,
  onValidate,
  onArchive,
  onDeploy,
  onQueueDeploy,
  onRestartDaemon,
  onCancelRestartDaemon,
  restartProgress,
  onSetHold,
}: ConductorPanelProps): { header: TaskDockHeader; body: ReactNode } {
  const { t } = useTranslation();

  const conductorProvider = useTasksBoardUiStore((state) => state.conductorProvider);
  const setConductorProvider = useTasksBoardUiStore((state) => state.setConductorProvider);

  const [ensure, setEnsure] = useState<EnsureState>({ status: "loading" });
  // True once this project's conductor has been resolved at least once. Gates the
  // ensure effect below so that opening a task never re-runs it: the conductor
  // chat stays mounted behind the task view and must NOT be torn down and
  // re-bootstrapped, or an in-flight turn (the prompt the user just sent, the
  // reply being streamed) disappears from the panel.
  const [conductorResolved, setConductorResolved] = useState(false);
  // Bumped by « Réinitialiser » (and by the archived-conductor guard below):
  // re-runs the ensure effect, asking the daemon to retire the current conductor
  // and hand back an empty one.
  const [resetNonce, setResetNonce] = useState(0);
  // Whether THIS ensure run should carry the reset flag. A ref (not state) so the
  // effect reads it without becoming a dependency — the nonce alone drives re-runs,
  // and a re-render for any other reason must not resend a destructive reset.
  const pendingResetRef = useRef(false);
  const inDeployMode = dockDeployAgentId !== null;
  const inTaskMode = dockTask !== null && !inDeployMode;
  const dockTaskId = dockTask?.id ?? null;
  // Who is mounted vs merely visible in the dock — the rule that keeps a live
  // conductor conversation alive across a task or deploy-agent selection.
  const presence = resolveConductorDockPresence({
    hasDockedTask: inTaskMode,
    hasDeployAgent: inDeployMode,
    conductorResolved,
  });
  const { ensureSuspended } = presence;

  // Opening a task (or switching to another card) always lands on the chat tab.
  const [taskView, setTaskView] = useState<TaskView>("chat");
  useEffect(() => {
    setTaskView("chat");
  }, [dockTaskId]);
  // Save / delete / run from the Details tab hop back to the chat rather than
  // closing the whole drawer — the task stays open in front of the user.
  const handleTaskFormClose = useCallback(() => setTaskView("chat"), []);

  // "Réinitialiser": step away from the current conductor conversation and start
  // a fresh one. Confirmed first, then the ensure effect below re-runs with
  // reset=true. Nothing is destroyed: the previous exchange stays intact and
  // openable from the agent list, it simply stops being this project's conductor.
  const handleReset = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("tasks.conductor.resetTitle"),
        message: t("tasks.conductor.resetMessage"),
        confirmLabel: t("tasks.conductor.resetConfirm"),
        cancelLabel: t("common.actions.cancel"),
      });
      if (!confirmed) {
        return;
      }
      pendingResetRef.current = true;
      setEnsure({ status: "loading" });
      setResetNonce((nonce) => nonce + 1);
    })();
  }, [t]);

  // Two engines, so the control is a straight toggle rather than a menu. Only
  // the stored choice changes here: the ensure effect below reacts to it and asks
  // the daemon for that provider's conductor. Nothing is reset or destroyed.
  const nextConductorProvider: ConductorProvider =
    conductorProvider === "codex" ? "claude" : "codex";
  const handleToggleProvider = useCallback(() => {
    setConductorProvider(nextConductorProvider);
  }, [nextConductorProvider, setConductorProvider]);

  // « Réinitialiser » sits with the other input controls at the bottom of the
  // composer (after the mic + « Parler » buttons) instead of in the header, so
  // every input-control action lives in one place. Injected into the composer's
  // footer slot for the conductor chat only (see ComposerFooterControlsProvider
  // around the conductor pane below).
  const conductorResetControl = useMemo(
    () => (
      <Pressable
        onPress={handleReset}
        style={resetButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={t("tasks.conductor.resetTitle")}
        testID="conductor-reset"
      >
        <ThemedRotate size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      </Pressable>
    ),
    [handleReset, t],
  );

  // Watches the resolved conductor: if it turns out to be archived, we cannot
  // show its chat and must mint a new one.
  const ensuredAgentId = ensure.status === "ready" ? ensure.agentId : null;
  const conductorIsArchived = useSessionStore((state) =>
    serverId && ensuredAgentId
      ? Boolean(state.sessions[serverId]?.agents?.get(ensuredAgentId)?.archivedAt)
      : false,
  );
  useEffect(() => {
    if (!conductorIsArchived || inTaskMode || inDeployMode) {
      return;
    }
    pendingResetRef.current = true;
    setResetNonce((nonce) => nonce + 1);
  }, [conductorIsArchived, inTaskMode, inDeployMode]);

  const taskViewOptions = useMemo<SegmentedControlOption<TaskView>[]>(
    () => [
      { value: "chat", label: t("tasks.panel.chat"), testID: "conductor-task-view-chat" },
      { value: "details", label: t("tasks.panel.details"), testID: "conductor-task-view-details" },
      { value: "billing", label: t("tasks.panel.billing"), testID: "conductor-task-view-billing" },
    ],
    [t],
  );
  useEffect(() => {
    // Task chat reads the task's own linked agent — skip the conductor ensure so
    // opening a task on a board that never had a conductor does not spin one up.
    if (ensureSuspended) {
      return;
    }
    if (!serverId || !projectId) {
      setEnsure({ status: "error", message: t("tasks.conductor.noProject") });
      return;
    }
    let cancelled = false;
    // Consume the reset intent here: whether this run succeeds or fails, the flag
    // must not survive into the next ensure (a retry would archive the brand-new
    // conductor the user just got).
    const reset = pendingResetRef.current;
    pendingResetRef.current = false;
    setEnsure({ status: "loading" });
    const run = async () => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) {
        if (!cancelled) {
          setEnsure({ status: "error", message: t("tasks.conductor.noHost") });
        }
        return;
      }
      try {
        const payload = await client.tasksConductorEnsure(projectId, {
          provider: toConductorEnsureProvider(conductorProvider),
          ...(reset ? { reset: true } : {}),
        });
        if (cancelled) {
          return;
        }
        if (payload.error || !payload.agentId) {
          setEnsure({
            status: "error",
            message: payload.error ?? t("tasks.conductor.failed"),
          });
          return;
        }
        setEnsure({
          status: "ready",
          agentId: payload.agentId,
          workspaceId: payload.workspaceId ?? null,
          provider: conductorProvider,
        });
        setConductorResolved(true);
      } catch (error) {
        if (!cancelled) {
          setEnsure({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // `conductorProvider` is a dependency on purpose: flipping Claude ↔ Codex
    // re-runs the ensure (without reset) and hands back that provider's own
    // conductor conversation. `ensureSuspended` (not `inTaskMode`) is the gate:
    // once a conductor is resolved it stops changing, so opening or closing a
    // task never re-runs the ensure — no "loading" flash, no remount of a chat
    // that may be mid-turn.
  }, [serverId, projectId, t, ensureSuspended, resetNonce, conductorProvider]);

  const renderTaskBody = (task: KanbanTask) => (
    <>
      <View style={styles.tabs}>
        <SegmentedControl
          options={taskViewOptions}
          value={taskView}
          onValueChange={setTaskView}
          size="sm"
          fullWidth
          testID="conductor-task-view-switch"
        />
      </View>
      {/* The live chat stays mounted (hidden when off-tab) so its scroll and
          terminal state survive a hop to Details or Billing and back. */}
      <View style={taskView === "chat" ? styles.tabPane : styles.tabPaneHidden}>
        <TaskAgentChat
          key={`task:${task.id}:${task.links.taskAgentId ?? task.links.primaryAgentId ?? "none"}`}
          serverId={serverId}
          task={task}
          onRunNow={onRunNow}
          onValidate={onValidate}
          onApproveTask={onApproveTask}
          onArchive={onArchive}
          onDeploy={onDeploy}
          onQueueDeploy={onQueueDeploy}
          onRestartDaemon={onRestartDaemon}
          onCancelRestartDaemon={onCancelRestartDaemon}
          restartProgress={restartProgress}
        />
      </View>
      {taskView === "chat" ? null : (
        <EvolutionTaskProvider serverId={serverId} projectId={projectId} folderId={task.folderId}>
          <View style={styles.tabPane}>
            {taskView === "billing" ? (
              <TaskBillingView task={task} serverId={serverId} projectId={projectId} />
            ) : (
              <TaskDetailInlineForm
                serverId={serverId}
                task={task}
                visible
                onClose={handleTaskFormClose}
                onSave={onSave}
                onDelete={onDelete}
                onEstimate={onEstimate}
                onRunNow={onRunNow}
                onApprove={onApprove}
                onSetHold={onSetHold}
              />
            )}
          </View>
        </EvolutionTaskProvider>
      )}
    </>
  );

  // The conductor chat is NEVER unmounted by a task selection — it is hidden
  // behind the task view. Tearing it down used to lose the live conversation:
  // send a prompt, tap a card within the second, come back, and the panel had
  // remounted onto a snapshot taken before the send — no prompt, no streaming
  // reply, while the agent was in fact working. Same trick as the Chat/Details/
  // Billing tabs below, one level up.
  const renderConductorBody = () => {
    if (ensure.status === "loading") {
      return (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      );
    }
    if (ensure.status === "error") {
      return (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{ensure.message}</Text>
        </View>
      );
    }
    if (!serverId || ensure.status !== "ready") {
      return null;
    }
    // A conductor whose agent has been archived can never load its chat again
    // (the provider refuses to resume an archived thread). Rather than showing a
    // dead panel, ask the daemon for a fresh conductor — the user gets a working
    // prompt instead of an error they cannot act on.
    if (conductorIsArchived) {
      return (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      );
    }
    return (
      // Places « Réinitialiser » in the composer's footer button row (right of
      // the mic + « Parler » controls) for the conductor chat only.
      <ComposerFooterControlsProvider controls={conductorResetControl}>
        <EmbeddedAgentPane
          key={`conductor:${ensure.provider}:${ensure.agentId}`}
          serverId={serverId}
          agentId={ensure.agentId}
          workspaceId={ensure.workspaceId}
          paneKey={`tasks:conductor:${ensure.provider}`}
          // Hidden behind a task view: still mounted and still receiving its
          // stream, but no longer the focused pane — so it does not fight the task
          // chat for the keyboard or clear its own attention badge while off-screen.
          focused={presence.conductorFocused}
        />
      </ComposerFooterControlsProvider>
    );
  };

  // Task mode gets a back arrow (to the conductor); conductor mode shows the wand
  // leading icon. Details/Billing are tabs in the body now, not a header action.
  // The dock owns close/collapse/drag.
  const header = useMemo<TaskDockHeader>(() => {
    if (inDeployMode) {
      return {
        title: t("tasks.board.deployAgentTitle"),
        back: {
          onPress: onBackToConductor,
          accessibilityLabel: t("tasks.conductor.backToConductor"),
        },
      };
    }
    if (inTaskMode && dockTask) {
      return {
        title: dockTask.title,
        back: {
          onPress: onBackToConductor,
          accessibilityLabel: t("tasks.conductor.backToConductor"),
        },
      };
    }
    return {
      title: t("tasks.conductor.title"),
      leading: <ThemedWand size={ICON_SIZE.sm} uniProps={mutedColorMapping} />,
      // Conductor mode only: pick the engine (Claude / Codex). « Réinitialiser »
      // is no longer here — it sits with the input controls at the bottom of the
      // composer (see `conductorResetControl`).
      actions: (
        <View style={styles.headerActions}>
          <Pressable
            onPress={handleToggleProvider}
            style={providerButtonStyle}
            accessibilityRole="button"
            accessibilityLabel={t("tasks.conductor.switchProvider", {
              provider: CONDUCTOR_PROVIDER_LABELS[nextConductorProvider],
            })}
            testID="conductor-provider-toggle"
          >
            <Text style={styles.providerLabel}>{CONDUCTOR_PROVIDER_LABELS[conductorProvider]}</Text>
          </Pressable>
        </View>
      ),
    };
  }, [
    inDeployMode,
    inTaskMode,
    dockTask,
    onBackToConductor,
    handleToggleProvider,
    conductorProvider,
    nextConductorProvider,
    t,
  ]);

  const body = (
    // No provider bar here: Claude vs Codex is chosen in Paseo's native menu under
    // the prompt composer (see CONDUCTOR_PROVIDER).
    <View style={styles.body}>
      {presence.showTaskView && dockTask ? (
        <View style={styles.tabPane}>{renderTaskBody(dockTask)}</View>
      ) : null}
      {/* The grouped batch-publication agent: same slot as a task view, so its
          build → publish → verdict is watched live in the dock instead of a full
          agent tab. Mounted only while shown — it is not the always-alive pane. */}
      {presence.showDeployView && serverId && dockDeployAgentId ? (
        <View style={styles.tabPane}>
          <EmbeddedAgentPane
            key={`deploy:${dockDeployAgentId}`}
            serverId={serverId}
            agentId={dockDeployAgentId}
            workspaceId={null}
            paneKey="tasks:deploy"
            focused
          />
        </View>
      ) : null}
      {/* Kept mounted whatever the dock shows — see `renderConductorBody`. */}
      <View style={presence.conductorVisible ? styles.tabPane : styles.tabPaneHidden}>
        {renderConductorBody()}
      </View>
    </View>
  );

  return { header, body };
}

function resetButtonStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.resetButton, (hovered || pressed) && styles.resetButtonHovered];
}

function providerButtonStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.providerButton, (hovered || pressed) && styles.resetButtonHovered];
}

function EmbeddedAgentPane({
  serverId,
  agentId,
  workspaceId,
  paneKey,
  focused,
}: {
  serverId: string;
  agentId: string;
  workspaceId: string | null;
  /**
   * Stable namespace for this pane's tab identity (e.g. the conductor's provider,
   * or the deploy agent). The agent id is appended to it, so switching agents
   * hands the workspace pane a fresh tab instead of leaking scroll/terminal state.
   */
  paneKey: string;
  /**
   * False while a task view covers the conductor. The pane stays mounted (its
   * conversation, scroll and composer survive), it simply stops being the
   * interactive pane. Focus coming back re-runs the panel's own history catch-up,
   * which fills any gap without replacing what is already on screen.
   */
  focused: boolean;
}) {
  // The composer stays mounted while the pane is hidden, so an input that still
  // held focus would leave the keyboard standing over the task view. Losing pane
  // focus is the moment to put it away (native only — web has no soft keyboard
  // to strand, and the user may still be typing in another field there).
  const wasFocusedRef = useRef(focused);
  useEffect(() => {
    if (isNative && wasFocusedRef.current && !focused) {
      Keyboard.dismiss();
    }
    wasFocusedRef.current = focused;
  }, [focused]);

  const content = useMemo(() => {
    const openInNativeWorkspace = () => {
      if (workspaceId) {
        navigateToAgent({ serverId, agentId, workspaceId });
      }
    };
    return buildWorkspacePaneContentModel({
      tab: {
        key: `${paneKey}:${agentId}`,
        tabId: `${paneKey}:${agentId}`,
        kind: "agent",
        target: { kind: "agent", agentId },
      },
      normalizedServerId: serverId,
      normalizedWorkspaceId: workspaceId ?? "",
      onOpenTab: openInNativeWorkspace,
      onCloseCurrentTab: openInNativeWorkspace,
      onRetargetCurrentTab: openInNativeWorkspace,
      onOpenWorkspaceFile: openInNativeWorkspace,
      onOpenImportSheet: openInNativeWorkspace,
    });
  }, [serverId, agentId, workspaceId, paneKey]);

  return (
    <View style={styles.paneHost}>
      <WorkspacePaneContent
        content={content}
        isWorkspaceFocused={focused}
        isPaneFocused={focused}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The embedded pane / chat manages its own scroll and needs a bounded flex
  // height, so the sheet body is a static flex column with `minHeight: 0`.
  body: {
    flex: 1,
    minHeight: 0,
  },
  tabs: {
    paddingTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  resetButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
  },
  providerButton: {
    height: 28,
    paddingHorizontal: theme.spacing[2],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
  },
  providerLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
  },
  resetButtonHovered: {
    backgroundColor: theme.colors.surface1,
  },
  tabPane: {
    flex: 1,
    minHeight: 0,
  },
  tabPaneHidden: {
    display: "none",
  },
  paneHost: {
    flex: 1,
    minHeight: 0,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  errorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

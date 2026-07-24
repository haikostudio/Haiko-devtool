import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Wand2 } from "lucide-react-native";
import { TaskBottomDock, type TaskDockHeader } from "@/components/tasks/task-bottom-dock";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { TaskAgentChat } from "@/components/tasks/task-agent-chat";
import { TaskBillingView } from "@/components/tasks/task-billing-view";
import {
  TaskDetailInlineForm,
  type TaskDetailSaveInput,
} from "@/components/tasks/task-detail-sheet";
import { EvolutionTaskProvider } from "@/contexts/evolution-task-context";
import type { KanbanTask } from "@/data/tasks";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
} from "@/screens/workspace/workspace-pane-content";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedWand = withUnistyles(Wand2);

type EnsureState =
  | { status: "loading" }
  | { status: "ready"; agentId: string; workspaceId: string | null }
  | { status: "error"; message: string };

/** Task-mode tabs, chat first. Details/Billing live here too — no separate drawer. */
type TaskView = "chat" | "details" | "billing";

export interface ConductorPanelProps {
  serverId: string | null;
  projectId: string | null;
  /**
   * When set, the dock shows this task's chat + details + billing tabs instead of
   * the persistent conductor agent. `null` = conductor mode.
   */
  dockTask: KanbanTask | null;
  /** Reset the dock back to the conductor agent (clears the task chat). */
  onBackToConductor: () => void;
  /** Launch an agent for a task that has none yet (empty-state button). */
  onRunNow: (taskId: string) => void;
  /** Persist edits from the task's Details tab. */
  onSave: (input: TaskDetailSaveInput) => void;
  onDelete: (taskId: string) => void;
  onEstimate: (taskId: string) => void;
  onApprove: (taskId: string) => void;
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
export function ConductorPanel({
  serverId,
  projectId,
  dockTask,
  onBackToConductor,
  onRunNow,
  onSave,
  onDelete,
  onEstimate,
  onApprove,
  onSetHold,
  onClose,
}: ConductorPanelProps) {
  const { t } = useTranslation();

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

  const [ensure, setEnsure] = useState<EnsureState>({ status: "loading" });
  const inTaskMode = dockTask !== null;
  const dockTaskId = dockTask?.id ?? null;

  // Opening a task (or switching to another card) always lands on the chat tab.
  const [taskView, setTaskView] = useState<TaskView>("chat");
  useEffect(() => {
    setTaskView("chat");
  }, [dockTaskId]);
  // Save / delete / run from the Details tab hop back to the chat rather than
  // closing the whole drawer — the task stays open in front of the user.
  const handleTaskFormClose = useCallback(() => setTaskView("chat"), []);

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
    // opening a task never spins up the conductor agent unnecessarily.
    if (inTaskMode) {
      return;
    }
    if (!serverId || !projectId) {
      setEnsure({ status: "error", message: t("tasks.conductor.noProject") });
      return;
    }
    let cancelled = false;
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
        const payload = await client.tasksConductorEnsure(projectId);
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
        });
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
  }, [serverId, projectId, t, inTaskMode]);

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

  const renderBody = () => {
    if (inTaskMode && dockTask) {
      return renderTaskBody(dockTask);
    }
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
    if (!serverId) {
      return null;
    }
    return (
      <EmbeddedConductorPane
        key={`conductor:${ensure.agentId}`}
        serverId={serverId}
        agentId={ensure.agentId}
        workspaceId={ensure.workspaceId}
      />
    );
  };

  // Task mode gets a back arrow (to the conductor); conductor mode shows the wand
  // leading icon. Details/Billing are tabs in the body now, not a header action.
  // The dock owns close/collapse/drag.
  const header = useMemo<TaskDockHeader>(() => {
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
    };
  }, [inTaskMode, dockTask, onBackToConductor, t]);

  return (
    <TaskBottomDock
      header={header}
      visible
      onClose={onClose}
      height={conductorHeight}
      offsetX={conductorOffsetX}
      collapsed={conductorCollapsed}
      onResize={setConductorHeight}
      onMove={setConductorOffsetX}
      onToggleCollapse={handleToggleCollapse}
      testID="conductor-panel"
    >
      <View style={styles.body}>{renderBody()}</View>
    </TaskBottomDock>
  );
}

function EmbeddedConductorPane({
  serverId,
  agentId,
  workspaceId,
}: {
  serverId: string;
  agentId: string;
  workspaceId: string | null;
}) {
  const content = useMemo(() => {
    const openInNativeWorkspace = () => {
      if (workspaceId) {
        navigateToAgent({ serverId, agentId, workspaceId });
      }
    };
    return buildWorkspacePaneContentModel({
      tab: {
        key: `tasks:conductor:${agentId}`,
        tabId: `tasks:conductor:${agentId}`,
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
  }, [serverId, agentId, workspaceId]);

  return (
    <View style={styles.paneHost}>
      <WorkspacePaneContent content={content} isWorkspaceFocused isPaneFocused />
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

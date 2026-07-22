import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PanelRight, Wand2 } from "lucide-react-native";
import { TaskBottomDock, type TaskDockHeader } from "@/components/tasks/task-bottom-dock";
import type { KanbanTask } from "@/data/tasks";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { TaskAgentChat } from "@/components/tasks/task-agent-chat";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
} from "@/screens/workspace/workspace-pane-content";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedPanelRight = withUnistyles(PanelRight);
const ThemedWand = withUnistyles(Wand2);

type EnsureState =
  | { status: "loading" }
  | { status: "ready"; agentId: string; workspaceId: string | null }
  | { status: "error"; message: string };

export interface ConductorPanelProps {
  serverId: string | null;
  projectId: string | null;
  /**
   * When set, the dock shows this task's agent chat instead of the persistent
   * conductor agent. `null` = conductor mode.
   */
  dockTask: KanbanTask | null;
  /** Reset the dock back to the conductor agent (clears the task chat). */
  onBackToConductor: () => void;
  /** Open the Details+Billing drawer for the given task. */
  onOpenDetails: (taskId: string) => void;
  /** Launch an agent for a task that has none yet (empty-state button). */
  onRunNow: (taskId: string) => void;
  onClose: () => void;
}

/**
 * The "Chef d'orchestre" chat drawer, rendered through the shared
 * `TaskBottomDock`: a bottom sheet on compact, and on desktop a drawer docked to
 * the bottom of the board that the user can drag left/right, resize, and collapse
 * — never a modal floating in the middle of the screen. Shows the persistent
 * per-project conductor agent by default, and swaps to the selected task's agent
 * chat when a task is tapped on the board. On mount (in conductor mode) it ensures
 * the conductor exists on the host and embeds its live agent via the same
 * WorkspacePaneContent the workspace screen uses; in task mode it embeds the
 * task's primary agent. Switching agents fully remounts the pane (React `key`) so
 * no scroll/terminal state leaks across agents.
 */
export function ConductorPanel({
  serverId,
  projectId,
  dockTask,
  onBackToConductor,
  onOpenDetails,
  onRunNow,
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
  const handleOpenDetailsPress = useCallback(() => {
    if (dockTaskId) {
      onOpenDetails(dockTaskId);
    }
  }, [dockTaskId, onOpenDetails]);

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

  const renderBody = () => {
    if (inTaskMode && dockTask) {
      return (
        <TaskAgentChat
          key={`task:${dockTask.id}:${dockTask.links.primaryAgentId ?? "none"}`}
          serverId={serverId}
          task={dockTask}
          onRunNow={onRunNow}
        />
      );
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

  // Task mode gets a back arrow (to the conductor) and an "open details" action;
  // conductor mode shows the wand leading icon. The dock owns close/collapse/drag.
  const header = useMemo<TaskDockHeader>(() => {
    if (inTaskMode && dockTask) {
      return {
        title: dockTask.title,
        back: {
          onPress: onBackToConductor,
          accessibilityLabel: t("tasks.conductor.backToConductor"),
        },
        actions: (
          <Pressable
            onPress={handleOpenDetailsPress}
            accessibilityRole="button"
            accessibilityLabel={t("tasks.conductor.openDetails")}
            style={styles.detailsButton}
            testID="conductor-panel-open-details"
          >
            <ThemedPanelRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
            <Text style={styles.detailsButtonLabel} numberOfLines={1}>
              {t("tasks.conductor.openDetails")}
            </Text>
          </Pressable>
        ),
      };
    }
    return {
      title: t("tasks.conductor.title"),
      leading: <ThemedWand size={ICON_SIZE.sm} uniProps={mutedColorMapping} />,
    };
  }, [inTaskMode, dockTask, onBackToConductor, handleOpenDetailsPress, t]);

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
  detailsButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  detailsButtonLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
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

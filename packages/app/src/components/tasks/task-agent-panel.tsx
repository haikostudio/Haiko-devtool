import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bot, PanelRightClose, PanelRightOpen, X } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  TaskDetailInlineForm,
  type TaskDetailSaveInput,
} from "@/components/tasks/task-detail-sheet";
import { TaskBillingView } from "@/components/tasks/task-billing-view";
import { EvolutionTaskProvider } from "@/contexts/evolution-task-context";
import type { KanbanTask } from "@/data/tasks";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
} from "@/screens/workspace/workspace-pane-content";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedBot = withUnistyles(Bot);
const ThemedX = withUnistyles(X);
const ThemedPanelClose = withUnistyles(PanelRightClose);
const ThemedPanelOpen = withUnistyles(PanelRightOpen);

type PanelView = "chat" | "details" | "billing";

export interface TaskAgentPanelProps {
  serverId: string | null;
  projectId: string | null;
  task: KanbanTask;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onClose: () => void;
  /**
   * Full-screen (compact/mobile) presentation: drop the desktop-only collapse
   * affordance and never render the collapsed rail. The tabs and body are the
   * same as the desktop side panel.
   */
  fullscreen?: boolean;
  onSave: (input: TaskDetailSaveInput) => void;
  onDelete: (taskId: string) => void;
  onEstimate: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
  onApprove: (taskId: string) => void;
}

/**
 * Desktop-only side panel to the right of the kanban board. Mirrors the native
 * Paseo agent for the selected task's primary agent (same `WorkspacePaneContent`
 * the workspace screen mounts, so it's a live mirror — not a copy) and exposes
 * the task editor as a second tab. When no agent has run yet, offers to launch
 * one.
 */
export function TaskAgentPanel(props: TaskAgentPanelProps) {
  const { serverId, projectId, task, collapsed, onToggleCollapse, onClose, fullscreen } = props;
  const { t } = useTranslation();
  const [view, setView] = useState<PanelView>("chat");

  const agentId = task.links.primaryAgentId ?? null;
  // Prefer the task's recorded workspace; fall back to the agent's own workspace
  // from the session store so the embedded pane always has a scope.
  const agentWorkspaceId = useSessionStore((state) =>
    serverId && agentId ? state.sessions[serverId]?.agents?.get(agentId)?.workspaceId : undefined,
  );
  const workspaceId = task.links.workspaceId ?? agentWorkspaceId ?? null;

  const handleSwitchToChat = useCallback(() => setView("chat"), []);

  const renderBody = () => {
    if (view === "chat") {
      return (
        <ChatView
          serverId={serverId}
          task={task}
          agentId={agentId}
          workspaceId={workspaceId}
          onRunNow={props.onRunNow}
        />
      );
    }
    if (view === "billing") {
      return <TaskBillingView task={task} serverId={serverId} projectId={projectId} />;
    }
    return (
      <TaskDetailInlineForm
        serverId={serverId}
        task={task}
        visible
        onClose={handleSwitchToChat}
        onSave={props.onSave}
        onDelete={props.onDelete}
        onEstimate={props.onEstimate}
        onRunNow={props.onRunNow}
        onApprove={props.onApprove}
      />
    );
  };

  const viewOptions = useMemo<SegmentedControlOption<PanelView>[]>(
    () => [
      { value: "chat", label: t("tasks.panel.chat"), testID: "task-panel-view-chat" },
      { value: "details", label: t("tasks.panel.details"), testID: "task-panel-view-details" },
      { value: "billing", label: t("tasks.panel.billing"), testID: "task-panel-view-billing" },
    ],
    [t],
  );

  if (collapsed && !fullscreen) {
    return (
      <View style={styles.collapsedRail}>
        <Pressable
          onPress={onToggleCollapse}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.panel.expand")}
          style={styles.collapsedButton}
          testID="task-panel-expand"
        >
          <ThemedPanelOpen size={ICON_SIZE.md} uniProps={mutedColorMapping} />
        </Pressable>
        <ThemedBot size={ICON_SIZE.md} uniProps={mutedColorMapping} />
      </View>
    );
  }

  return (
    <View style={styles.panel} testID="task-agent-panel">
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {task.title}
        </Text>
        {fullscreen ? null : (
          <Pressable
            onPress={onToggleCollapse}
            accessibilityRole="button"
            accessibilityLabel={t("tasks.panel.collapse")}
            style={styles.headerButton}
            testID="task-panel-collapse"
          >
            <ThemedPanelClose size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          </Pressable>
        )}
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("common.actions.close")}
          style={styles.headerButton}
          testID="task-panel-close"
        >
          <ThemedX size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </Pressable>
      </View>

      <View style={styles.tabs}>
        <SegmentedControl
          options={viewOptions}
          value={view}
          onValueChange={setView}
          size="sm"
          fullWidth
          testID="task-panel-view-switch"
        />
      </View>

      <EvolutionTaskProvider serverId={serverId} projectId={projectId} folderId={task.folderId}>
        <View style={styles.body}>{renderBody()}</View>
      </EvolutionTaskProvider>
    </View>
  );
}

function ChatView({
  serverId,
  task,
  agentId,
  workspaceId,
  onRunNow,
}: {
  serverId: string | null;
  task: KanbanTask;
  agentId: string | null;
  workspaceId: string | null;
  onRunNow: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const handleRun = useCallback(() => onRunNow(task.id), [onRunNow, task.id]);

  if (serverId && agentId && workspaceId) {
    return <EmbeddedAgentPane serverId={serverId} agentId={agentId} workspaceId={workspaceId} />;
  }

  return (
    <View style={styles.emptyState}>
      <ThemedBot size={ICON_SIZE.lg} uniProps={mutedColorMapping} />
      <Text style={styles.emptyText}>{t("tasks.panel.noAgent")}</Text>
      {serverId ? (
        <Button onPress={handleRun} testID="task-panel-launch-agent">
          {t("tasks.panel.launchAgent")}
        </Button>
      ) : null}
    </View>
  );
}

function EmbeddedAgentPane({
  serverId,
  agentId,
  workspaceId,
}: {
  serverId: string;
  agentId: string;
  workspaceId: string;
}) {
  const content = useMemo(() => {
    const openInNativeWorkspace = () => {
      navigateToAgent({ serverId, agentId, workspaceId });
    };
    return buildWorkspacePaneContentModel({
      tab: {
        key: `tasks:agent:${agentId}`,
        tabId: `tasks:agent:${agentId}`,
        kind: "agent",
        target: { kind: "agent", agentId },
      },
      normalizedServerId: serverId,
      normalizedWorkspaceId: workspaceId,
      // The tasks board owns no tab strip; tab-management intents fall back to
      // opening the agent in its native workspace.
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
  panel: {
    // No left border: the board's resize handle already draws the divider.
    width: "100%",
    height: "100%",
    backgroundColor: theme.colors.surface0,
  },
  collapsedRail: {
    width: "100%",
    height: "100%",
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    paddingTop: theme.spacing[3],
    gap: theme.spacing[3],
  },
  collapsedButton: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  headerButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  tabs: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  body: {
    flex: 1,
  },
  paneHost: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

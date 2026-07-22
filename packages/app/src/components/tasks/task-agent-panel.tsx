import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bot, PanelRightClose, PanelRightOpen, X } from "lucide-react-native";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  TaskDetailInlineForm,
  type TaskDetailSaveInput,
} from "@/components/tasks/task-detail-sheet";
import { TaskBillingView } from "@/components/tasks/task-billing-view";
import { EvolutionTaskProvider } from "@/contexts/evolution-task-context";
import type { KanbanTask } from "@/data/tasks";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedBot = withUnistyles(Bot);
const ThemedX = withUnistyles(X);
const ThemedPanelClose = withUnistyles(PanelRightClose);
const ThemedPanelOpen = withUnistyles(PanelRightOpen);

type PanelView = "details" | "billing";

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
  onSetHold?: (taskId: string, hold: boolean) => void;
}

/**
 * The task's "Details" drawer — the right-hand side panel on desktop, the
 * full-screen sheet on compact. Holds the task editor (Details) and its
 * Billing view as two tabs. The task's live agent chat lives elsewhere now (the
 * shared bottom "Chef d'orchestre" dock), so this panel is config-only.
 */
export function TaskAgentPanel(props: TaskAgentPanelProps) {
  const { serverId, projectId, task, collapsed, onToggleCollapse, onClose, fullscreen } = props;
  const { t } = useTranslation();
  const [view, setView] = useState<PanelView>("details");

  const renderBody = () => {
    if (view === "billing") {
      return <TaskBillingView task={task} serverId={serverId} projectId={projectId} />;
    }
    return (
      <TaskDetailInlineForm
        serverId={serverId}
        task={task}
        visible
        onClose={onClose}
        onSave={props.onSave}
        onDelete={props.onDelete}
        onEstimate={props.onEstimate}
        onRunNow={props.onRunNow}
        onApprove={props.onApprove}
        onSetHold={props.onSetHold}
      />
    );
  };

  const viewOptions = useMemo<SegmentedControlOption<PanelView>[]>(
    () => [
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
}));

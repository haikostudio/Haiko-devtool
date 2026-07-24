import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { TaskBottomDock, type TaskDockHeader } from "@/components/tasks/task-bottom-dock";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  TaskDetailInlineForm,
  type TaskDetailSaveInput,
} from "@/components/tasks/task-detail-sheet";
import { TaskBillingView } from "@/components/tasks/task-billing-view";
import { EvolutionTaskProvider } from "@/contexts/evolution-task-context";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import type { KanbanTask } from "@/data/tasks";

type PanelView = "details" | "billing";

export interface TaskDetailDrawerProps {
  serverId: string | null;
  projectId: string | null;
  task: KanbanTask | null;
  visible: boolean;
  onClose: () => void;
  onSave: (input: TaskDetailSaveInput) => void;
  onDelete: (taskId: string) => void;
  onEstimate: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  onSetHold?: (taskId: string, hold: boolean) => void;
}

/**
 * The task's "Details" + "Billing" drawer, unified across form factors through
 * the shared `TaskBottomDock`: a bottom sheet on compact, and on desktop a drawer
 * docked to the bottom that the user can drag left/right, resize, and collapse —
 * the same kind of drawer as the conductor chat dock, with its own persisted
 * geometry so the two can be arranged side by side.
 *
 * The body is a fixed SegmentedControl over the selected view. Both views
 * (`TaskDetailInlineForm`, `TaskBillingView`) own their own flex ScrollView, so
 * the dock uses a static body that hands them a bounded flex height
 * (`minHeight: 0`). Fresh mount per task via `key` so no state leaks between cards.
 */
export function TaskDetailDrawer(props: TaskDetailDrawerProps) {
  if (!props.task) {
    return null;
  }
  return <TaskDetailDrawerInner key={props.task.id} {...props} task={props.task} />;
}

function TaskDetailDrawerInner({
  serverId,
  projectId,
  task,
  visible,
  onClose,
  onSave,
  onDelete,
  onEstimate,
  onRunNow,
  onApprove,
  onSetHold,
}: TaskDetailDrawerProps & { task: KanbanTask }) {
  const { t } = useTranslation();
  const [view, setView] = useState<PanelView>("details");

  const detailsHeight = useTasksBoardUiStore((state) => state.detailsHeight);
  const detailsOffsetX = useTasksBoardUiStore((state) => state.detailsOffsetX);
  const detailsCollapsed = useTasksBoardUiStore((state) => state.detailsCollapsed);
  const setDetailsHeight = useTasksBoardUiStore((state) => state.setDetailsHeight);
  const setDetailsOffsetX = useTasksBoardUiStore((state) => state.setDetailsOffsetX);
  const setDetailsCollapsed = useTasksBoardUiStore((state) => state.setDetailsCollapsed);
  const handleToggleCollapse = useCallback(
    () => setDetailsCollapsed(!detailsCollapsed),
    [detailsCollapsed, setDetailsCollapsed],
  );

  const header = useMemo((): TaskDockHeader => ({ title: task.title }), [task.title]);

  const viewOptions = useMemo<SegmentedControlOption<PanelView>[]>(
    () => [
      { value: "details", label: t("tasks.panel.details"), testID: "task-panel-view-details" },
      { value: "billing", label: t("tasks.panel.billing"), testID: "task-panel-view-billing" },
    ],
    [t],
  );

  return (
    <TaskBottomDock
      header={header}
      visible={visible}
      onClose={onClose}
      height={detailsHeight}
      offsetX={detailsOffsetX}
      collapsed={detailsCollapsed}
      onResize={setDetailsHeight}
      onMove={setDetailsOffsetX}
      onToggleCollapse={handleToggleCollapse}
      testID="task-detail-drawer"
    >
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
        <View style={styles.body}>
          {view === "billing" ? (
            <TaskBillingView task={task} serverId={serverId} projectId={projectId} />
          ) : (
            <TaskDetailInlineForm
              serverId={serverId}
              task={task}
              visible
              onClose={onClose}
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
    </TaskBottomDock>
  );
}

const styles = StyleSheet.create((theme) => ({
  tabs: {
    // The sheet no longer indents the dock body, so the tabs own their own
    // horizontal inset (matching the conductor panel) to stay off the edges.
    paddingTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  body: {
    flex: 1,
    // The selected view owns its own scroll; a flex column that hands it a
    // bounded height needs `minHeight: 0` or the content overflows on web.
    minHeight: 0,
  },
}));

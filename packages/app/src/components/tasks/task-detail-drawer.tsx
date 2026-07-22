import { useMemo, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  TaskDetailInlineForm,
  type TaskDetailSaveInput,
} from "@/components/tasks/task-detail-sheet";
import { TaskBillingView } from "@/components/tasks/task-billing-view";
import { EvolutionTaskProvider } from "@/contexts/evolution-task-context";
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
 * the shared `AdaptiveModalSheet`: a bottom sheet on compact, a centered card on
 * desktop (no backdrop dim, so the board behind stays visible/interactive).
 *
 * The body is a fixed SegmentedControl over the selected view. Both views
 * (`TaskDetailInlineForm`, `TaskBillingView`) own their own flex ScrollView, so
 * the sheet uses a static (`scrollable={false}`) body that hands them a bounded
 * flex height (`minHeight: 0`) — nesting them in the sheet's own scroll would
 * double-scroll. Fresh mount per task via `key` so no state leaks between cards.
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

  const header = useMemo((): SheetHeader => ({ title: task.title }), [task.title]);

  const viewOptions = useMemo<SegmentedControlOption<PanelView>[]>(
    () => [
      { value: "details", label: t("tasks.panel.details"), testID: "task-panel-view-details" },
      { value: "billing", label: t("tasks.panel.billing"), testID: "task-panel-view-billing" },
    ],
    [t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      scrollable={false}
      desktopBackdrop={false}
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
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  tabs: {
    paddingBottom: theme.spacing[2],
  },
  body: {
    flex: 1,
    // The selected view owns its own scroll; a flex column that hands it a
    // bounded height needs `minHeight: 0` or the content overflows on web.
    minHeight: 0,
  },
}));

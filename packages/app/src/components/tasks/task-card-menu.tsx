import { memo, useCallback } from "react";
import { MoreVertical, Play, RefreshCw, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KANBAN_COLUMNS } from "@/components/tasks/kanban-columns";
import type { KanbanTask, TaskColumn } from "@/data/tasks";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const ThemedKebab = withUnistyles(MoreVertical);
const ThemedPlay = withUnistyles(Play);
const ThemedRefresh = withUnistyles(RefreshCw);
const ThemedTrash = withUnistyles(Trash2);

const MENU_ICON_SIZE = 16;
const runLeading = <ThemedPlay size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const reanalyzeLeading = <ThemedRefresh size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const deleteLeading = <ThemedTrash size={MENU_ICON_SIZE} uniProps={destructiveColorMapping} />;

export interface TaskCardMenuHandlers {
  onMoveTask: (input: { taskId: string; column: TaskColumn; index: number }) => void;
  onRunTask: (taskId: string) => void;
  onReanalyzeTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
}

/**
 * Per-card overflow menu (⋮): launch the task now (run-now — moves it straight
 * into "in progress"), re-run its analysis/estimate, or move it to another
 * column. Launch + re-analyze only make sense before a task runs, so they're
 * gated to the backlog/scheduled columns; every card can still be moved. Shared
 * by both board shapes (the native scrollable board and the web dnd board).
 */
export const TaskCardMenu = memo(function TaskCardMenu({
  task,
  labels,
  onMoveTask,
  onRunTask,
  onReanalyzeTask,
  onDeleteTask,
}: {
  task: KanbanTask;
  labels: Record<TaskColumn, string>;
} & TaskCardMenuHandlers) {
  const { t } = useTranslation();
  const canLaunch =
    task.column === "backlog" || task.column === "validated" || task.column === "scheduled";

  const handleRun = useCallback(() => {
    onRunTask(task.id);
  }, [onRunTask, task.id]);

  const handleReanalyze = useCallback(() => {
    onReanalyzeTask(task.id);
  }, [onReanalyzeTask, task.id]);

  // Guard the destructive action behind a confirmation so a stray tap can't wipe
  // a card. The confirm lives here so both board shapes get it for free; the
  // screen handler only has to perform the delete + toast.
  const handleDelete = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("tasks.confirmDelete.title"),
        message: t("tasks.confirmDelete.message"),
        confirmLabel: t("tasks.confirmDelete.confirm"),
        cancelLabel: t("tasks.confirmDelete.cancel"),
        destructive: true,
      });
      if (confirmed) {
        onDeleteTask(task.id);
      }
    })();
  }, [onDeleteTask, task.id, t]);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.trigger}
        accessibilityRole="button"
        accessibilityLabel={t("tasks.actions.taskActions")}
        testID={`tasks-card-menu-${task.id}`}
      >
        <ThemedKebab size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" offset={4} width={220}>
        {canLaunch ? (
          <DropdownMenuItem
            leading={runLeading}
            onSelect={handleRun}
            testID={`tasks-run-${task.id}`}
          >
            {t("tasks.actions.runNow")}
          </DropdownMenuItem>
        ) : null}
        {canLaunch ? (
          <DropdownMenuItem
            leading={reanalyzeLeading}
            onSelect={handleReanalyze}
            testID={`tasks-reanalyze-${task.id}`}
          >
            {t("tasks.actions.reanalyze")}
          </DropdownMenuItem>
        ) : null}
        {canLaunch ? <DropdownMenuSeparator /> : null}
        {KANBAN_COLUMNS.filter((column) => column !== task.column).map((column) => (
          <MoveTaskMenuItem
            key={column}
            taskId={task.id}
            column={column}
            label={t("tasks.actions.moveToColumn", { column: labels[column] })}
            onMoveTask={onMoveTask}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={deleteLeading}
          destructive
          onSelect={handleDelete}
          testID={`tasks-delete-${task.id}`}
        >
          {t("tasks.actions.deleteTask")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const MoveTaskMenuItem = memo(function MoveTaskMenuItem({
  taskId,
  column,
  label,
  onMoveTask,
}: {
  taskId: string;
  column: TaskColumn;
  label: string;
  onMoveTask: TaskCardMenuHandlers["onMoveTask"];
}) {
  const handleSelect = useCallback(() => {
    onMoveTask({ taskId, column, index: Number.MAX_SAFE_INTEGER });
  }, [onMoveTask, taskId, column]);
  return <DropdownMenuItem onSelect={handleSelect}>{label}</DropdownMenuItem>;
});

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
}));

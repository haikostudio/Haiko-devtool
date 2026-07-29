import { memo, useCallback } from "react";
import {
  ArchiveRestore,
  MoreVertical,
  PauseCircle,
  Play,
  PlayCircle,
  RefreshCw,
  Trash2,
} from "lucide-react-native";
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
import { isTaskDeployed } from "@/components/tasks/task-card-badge";
import { isTaskMoveAllowed } from "@/components/tasks/task-move-guard";
import type { KanbanTask, TaskColumn } from "@/data/tasks";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const ThemedKebab = withUnistyles(MoreVertical);
const ThemedPlay = withUnistyles(Play);
const ThemedRefresh = withUnistyles(RefreshCw);
const ThemedTrash = withUnistyles(Trash2);
const ThemedPause = withUnistyles(PauseCircle);
const ThemedResume = withUnistyles(PlayCircle);
const ThemedUnarchive = withUnistyles(ArchiveRestore);

const MENU_ICON_SIZE = 16;
const runLeading = <ThemedPlay size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const reanalyzeLeading = <ThemedRefresh size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const unarchiveLeading = <ThemedUnarchive size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const deleteLeading = <ThemedTrash size={MENU_ICON_SIZE} uniProps={destructiveColorMapping} />;
const holdLeading = <ThemedPause size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const unholdLeading = <ThemedResume size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;

export interface TaskCardMenuHandlers {
  onMoveTask: (input: { taskId: string; column: TaskColumn; index: number }) => void;
  onRunTask: (taskId: string) => void;
  onReanalyzeTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  /** "Retirer du prochain lot" / "Remettre dans le lot" on a queued card. */
  onToggleDeployHold?: ((taskId: string, hold: boolean) => void) | undefined;
}

/**
 * Per-card overflow menu (⋮): launch the task now (run-now — moves it straight
 * into "in progress"), re-run its analysis/estimate, or move it to another
 * column. Launch + re-analyze are POST-consent actions: they only appear once a
 * card has been validated ("Validé"/"Planifié"). A backlog ("À faire") or notes
 * card is inert — offering "Exécuter maintenant" there would skip the human
 * consent the "Validé" column exists to capture (and the daemon rejects it too).
 * Every card can still be moved. Shared by both board shapes.
 */
export const TaskCardMenu = memo(function TaskCardMenu({
  task,
  labels,
  onMoveTask,
  onRunTask,
  onReanalyzeTask,
  onDeleteTask,
  onToggleDeployHold,
}: {
  task: KanbanTask;
  labels: Record<TaskColumn, string>;
} & TaskCardMenuHandlers) {
  const { t } = useTranslation();
  // "Archivé" is the terminal resting column: cards there are frozen — no launch,
  // re-analyse, hold or free move. The one escape hatch is "Désarchiver", which
  // undoes a misfiled card straight back to where it came from.
  const isArchived = task.column === "archived";
  // Where "Désarchiver" sends the card: back to the column it left, or "Terminé"
  // as a safe fallback for older cards that never recorded an origin.
  const restoreColumn: TaskColumn = task.preArchiveColumn ?? "done";
  const handleUnarchive = useCallback(() => {
    onMoveTask({ taskId: task.id, column: restoreColumn, index: Number.MAX_SAFE_INTEGER });
  }, [onMoveTask, task.id, restoreColumn]);
  const canLaunch = task.column === "validated" || task.column === "scheduled";
  // Holding a card back only means something while it is still waiting to be
  // published: a live card has nothing left to be excluded from.
  const canHold =
    Boolean(onToggleDeployHold) && task.column === "deployed" && !isTaskDeployed(task);
  const held = task.deployHold === true;
  const handleToggleHold = useCallback(() => {
    onToggleDeployHold?.(task.id, !held);
  }, [onToggleDeployHold, task.id, held]);

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

  if (isArchived) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          style={styles.trigger}
          accessibilityLabel={t("tasks.actions.taskActions")}
          testID={`tasks-card-menu-${task.id}`}
        >
          <ThemedKebab size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem
            leading={unarchiveLeading}
            onSelect={handleUnarchive}
            testID={`tasks-unarchive-${task.id}`}
          >
            {t("tasks.actions.unarchive")}
          </DropdownMenuItem>
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
  }

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
        {canHold ? (
          <DropdownMenuItem
            leading={held ? unholdLeading : holdLeading}
            onSelect={handleToggleHold}
            testID={`tasks-deploy-hold-${task.id}`}
          >
            {t(held ? "tasks.actions.deployUnhold" : "tasks.actions.deployHold")}
          </DropdownMenuItem>
        ) : null}
        {canLaunch || canHold ? <DropdownMenuSeparator /> : null}
        {/* "Archivé" is a valid manual target now: a card at rest may be filed
            into the terminal column by hand. A card whose work is in flight only
            lists the columns it may still reach — no backward entry, since no
            backward button exists — and an already-archived card lists nothing,
            because it is frozen (see task-move-guard). */}
        {KANBAN_COLUMNS.filter(
          (column) => column !== task.column && isTaskMoveAllowed(task, column),
        ).map((column) => (
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

import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { KanbanTask, TaskBoard, TaskColumn } from "@/data/tasks";

export const KANBAN_COLUMNS: TaskColumn[] = ["backlog", "scheduled", "in_progress", "done"];

export interface KanbanColumnModel {
  column: TaskColumn;
  tasks: KanbanTask[];
}

export function buildColumnModels(board: TaskBoard | null, folderId: string): KanbanColumnModel[] {
  return KANBAN_COLUMNS.map((column) => ({
    column,
    tasks: (board?.tasks ?? [])
      .filter((task) => task.folderId === folderId && task.column === column)
      .sort(
        (left, right) => left.order - right.order || left.createdAt.localeCompare(right.createdAt),
      ),
  }));
}

export function useColumnLabels(): Record<TaskColumn, string> {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      backlog: t("tasks.columns.backlog"),
      scheduled: t("tasks.columns.scheduled"),
      in_progress: t("tasks.columns.inProgress"),
      done: t("tasks.columns.done"),
    }),
    [t],
  );
}

export interface KanbanBoardProps {
  board: TaskBoard | null;
  folderId: string;
  onMoveTask: (input: { taskId: string; column: TaskColumn; index: number }) => void;
  onPressTask: (task: KanbanTask) => void;
  onAddTask: (column: TaskColumn) => void;
  // Node rendered at the top of one column's body (inline new-task draft).
  columnExtras?: { column: TaskColumn; node: React.ReactNode } | null;
}

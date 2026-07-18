import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { KanbanTask, TaskBoard, TaskColumn } from "@/data/tasks";
import { deriveProjectIconColor } from "@/utils/project-icon-color";

export const KANBAN_COLUMNS: TaskColumn[] = ["backlog", "scheduled", "in_progress", "done"];

// Soft pastel wash for the column containers: the folder color (falling back to
// the derived project color) at low alpha, layered over surface0. Works on both
// light and dark themes because the tint is additive over the app background.
// Hex-suffix alpha, same technique as the documented status-pill tints.
const COLUMN_TINT_ALPHA = "14"; // ~8%

export function resolveBoardAccentColor(board: TaskBoard | null, folderId: string): string | null {
  if (!board) {
    return null;
  }
  const folderColor = board.folders.find((folder) => folder.id === folderId)?.color;
  return folderColor ?? deriveProjectIconColor(board.projectId);
}

export function columnTint(accentColor: string | null): string | null {
  return accentColor ? `${accentColor}${COLUMN_TINT_ALPHA}` : null;
}

// Per-column cap on the desktop board (columns grow to fill, then stop here and
// left-align). Shared so the timeline strip above the board can match the exact
// width of the columns block and line its edges up with the first/last column.
export const KANBAN_COLUMN_MAX_WIDTH = 360;

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

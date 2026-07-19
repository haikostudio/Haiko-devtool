import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { KanbanTask, TaskBoard, TaskColumn } from "@/data/tasks";
import { parseTaskTags } from "./task-tags";

// How the cards within each column are ordered. "deadline" is the default the
// board has always used; the rest are opt-in via the board's sort control.
export type TaskSortMode = "deadline" | "priority" | "title" | "created";

export const TASK_SORT_MODES: TaskSortMode[] = ["deadline", "priority", "title", "created"];

export const KANBAN_COLUMNS: TaskColumn[] = [
  "backlog",
  "validated",
  "scheduled",
  "in_progress",
  "done",
];

// Per-column cap on the desktop board (columns grow to fill, then stop here and
// left-align). Shared so the timeline strip above the board can match the exact
// width of the columns block and line its edges up with the first/last column.
export const KANBAN_COLUMN_MAX_WIDTH = 360;

export interface KanbanColumnModel {
  column: TaskColumn;
  tasks: KanbanTask[];
}

// Earliest deadline first (most overdue at the top); tasks with no parseable
// deadline sink below the dated ones. The manual board order and creation time
// break ties so same-day tasks stay stable.
function deadlineTime(task: KanbanTask): number {
  const dueDate = parseTaskTags(task.tags).deadline?.dueDate;
  return dueDate ? dueDate.getTime() : Number.POSITIVE_INFINITY;
}

function compareByDeadline(left: KanbanTask, right: KanbanTask): number {
  return (
    deadlineTime(left) - deadlineTime(right) ||
    left.order - right.order ||
    left.createdAt.localeCompare(right.createdAt)
  );
}

// High priority floats to the top; untagged tasks sink to the bottom. Deadline
// then breaks ties so the most urgent same-priority card still leads.
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, other: 3 };

function priorityRank(task: KanbanTask): number {
  const level = parseTaskTags(task.tags).priority?.level;
  return level ? PRIORITY_RANK[level] : 4;
}

function comparatorFor(mode: TaskSortMode): (left: KanbanTask, right: KanbanTask) => number {
  switch (mode) {
    case "priority":
      return (left, right) =>
        priorityRank(left) - priorityRank(right) || compareByDeadline(left, right);
    case "title":
      return (left, right) =>
        left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
        compareByDeadline(left, right);
    case "created":
      // Newest first.
      return (left, right) => right.createdAt.localeCompare(left.createdAt);
    default:
      return compareByDeadline;
  }
}

// Accent- and case-insensitive so "echeance" matches "échéance" and the query
// is forgiving of how agent-authored tags happen to be spelled.
function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function taskHaystack(task: KanbanTask): string {
  return normalizeForSearch([task.title, task.description ?? "", ...task.tags].join(" "));
}

// Smart match: every whitespace-separated term must appear somewhere in the
// task's title, description, or tags. Multi-term narrows (AND), so "hexapro thai"
// finds the card tagged HEXAPRO whose title mentions "thaï".
function matchesQuery(task: KanbanTask, needle: string): boolean {
  const haystack = taskHaystack(task);
  return normalizeForSearch(needle)
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export interface BuildColumnOptions {
  query?: string;
  sortMode?: TaskSortMode;
}

export function buildColumnModels(
  board: TaskBoard | null,
  folderId: string,
  options?: BuildColumnOptions,
): KanbanColumnModel[] {
  const needle = options?.query?.trim() ?? "";
  const compare = comparatorFor(options?.sortMode ?? "deadline");
  return KANBAN_COLUMNS.map((column) => ({
    column,
    tasks: (board?.tasks ?? [])
      .filter(
        (task) =>
          task.folderId === folderId &&
          task.column === column &&
          (needle === "" || matchesQuery(task, needle)),
      )
      .sort(compare),
  }));
}

export function useTaskSortLabels(): Record<TaskSortMode, string> {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      deadline: t("tasks.sort.deadline"),
      priority: t("tasks.sort.priority"),
      title: t("tasks.sort.title"),
      created: t("tasks.sort.created"),
    }),
    [t],
  );
}

export function useColumnLabels(): Record<TaskColumn, string> {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      backlog: t("tasks.columns.backlog"),
      validated: t("tasks.columns.validated"),
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
  // Launch a task now (run-now) / re-run its analysis, straight from a card's
  // overflow menu — no need to open the detail sheet.
  onRunTask: (taskId: string) => void;
  onReanalyzeTask: (taskId: string) => void;
  // Node rendered at the top of one column's body (inline new-task draft).
  columnExtras?: { column: TaskColumn; node: React.ReactNode } | null;
  // Board-level filter + ordering, driven by the search/sort toolbar.
  query?: string;
  sortMode?: TaskSortMode;
}

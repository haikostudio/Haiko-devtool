import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { KanbanTask, TaskBoard, TaskColumn } from "@/data/tasks";
import { parseTaskTags, type TaskPriorityLevel } from "./task-tags";

// Recency is the board's one and only ordering — there is no sort menu. Every
// column shows the most recent activity first. "done" ranks by completedAt (the
// moment a task actually finished, so the last task completed sits at the very
// top); every other column ranks by updatedAt. A column the user has hand-
// arranged by dragging switches to manual order — see ColumnControls.manualOrder.

export const KANBAN_COLUMNS: TaskColumn[] = [
  "notes",
  "backlog",
  "validated",
  "scheduled",
  "in_progress",
  "done",
  "deployed",
];

// Per-column cap on the desktop board (columns grow to fill, then stop here and
// left-align). Shared so the timeline strip above the board can match the exact
// width of the columns block and line its edges up with the first/last column.
export const KANBAN_COLUMN_MAX_WIDTH = 360;

export interface KanbanColumnModel {
  column: TaskColumn;
  tasks: KanbanTask[];
}

// The timestamp that drives a column's recency ordering. "done" cards rank by
// the moment they finished (completedAt); the fallback to updatedAt covers older
// cards stamped before completedAt existed. Every other column ranks by last
// touch (updatedAt).
function recencyKey(task: KanbanTask, column: TaskColumn): string {
  if (column === "done" && task.completedAt) {
    return task.completedAt;
  }
  return task.updatedAt;
}

// Most recent first — the last task to finish rises to the top of "done".
// Creation time then id break ties so cards touched in the same instant stay
// stable across renders.
function compareByRecency(column: TaskColumn) {
  return (left: KanbanTask, right: KanbanTask): number =>
    recencyKey(right, column).localeCompare(recencyKey(left, column)) ||
    right.createdAt.localeCompare(left.createdAt) ||
    left.id.localeCompare(right.id);
}

// Honors the hand-arranged position a drag-and-drop saved (the server persists
// `order` on every move). Creation time breaks ties so same-order cards stay
// stable.
function compareByManualOrder(left: KanbanTask, right: KanbanTask): number {
  return left.order - right.order || left.createdAt.localeCompare(right.createdAt);
}

// The "notes" draft column orders by what makes a note actionable: importance
// first (high → low → none), then the soonest deadline, then most-recent touch.
// Undated notes sink below dated ones so imminent deadlines lead the column.
const NOTE_PRIORITY_RANK: Record<TaskPriorityLevel, number> = {
  high: 0,
  medium: 1,
  low: 2,
  other: 3,
};
const NOTE_PRIORITY_NONE = 4;

function noteSortKeys(task: KanbanTask): { priority: number; deadline: number } {
  const { priority, deadline } = parseTaskTags(task.tags);
  return {
    priority: priority ? NOTE_PRIORITY_RANK[priority.level] : NOTE_PRIORITY_NONE,
    // Sort by absolute due date (ms); undated notes go last (Infinity).
    deadline: deadline?.dueDate ? deadline.dueDate.getTime() : Number.POSITIVE_INFINITY,
  };
}

function compareNotes(left: KanbanTask, right: KanbanTask): number {
  const leftKeys = noteSortKeys(left);
  const rightKeys = noteSortKeys(right);
  return (
    leftKeys.priority - rightKeys.priority ||
    leftKeys.deadline - rightKeys.deadline ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
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

// ---------------------------------------------------------------------------
// Sort (the sort button): choose which criterion orders a column. The default is
// "updated" — most recently modified first — which is what the board has always
// done; the other criteria are opt-in per column and last only for the session.
// A column the user has hand-arranged by dragging switches to manual order and
// ignores this entirely (see ColumnControls.manualOrder).
// ---------------------------------------------------------------------------

// The three importance levels the note editor writes (and the priority sort
// ranks). "other" — an unrecognized suffix on an existing tag — is never a
// choice the user can make.
export type TaskImportanceLevel = Exclude<TaskPriorityLevel, "other">;

export type ColumnSortMode = "updated" | "created" | "deadline" | "priority" | "title";

export const DEFAULT_COLUMN_SORT: ColumnSortMode = "updated";

export const COLUMN_SORT_MODES: ColumnSortMode[] = [
  "updated",
  "created",
  "deadline",
  "priority",
  "title",
];

// Importance first (high → low → none), then the soonest deadline, then recency.
function compareByPriority(left: KanbanTask, right: KanbanTask): number {
  const leftKeys = noteSortKeys(left);
  const rightKeys = noteSortKeys(right);
  return (
    leftKeys.priority - rightKeys.priority ||
    leftKeys.deadline - rightKeys.deadline ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

// Soonest deadline first; undated cards sink to the bottom.
function compareByDeadline(left: KanbanTask, right: KanbanTask): number {
  const leftKeys = noteSortKeys(left);
  const rightKeys = noteSortKeys(right);
  return (
    leftKeys.deadline - rightKeys.deadline ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

// Newest first, so a freshly captured task leads the column.
function compareByCreated(left: KanbanTask, right: KanbanTask): number {
  return (
    right.createdAt.localeCompare(left.createdAt) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

// Alphabetical, accent- and case-insensitive.
function compareByTitle(left: KanbanTask, right: KanbanTask): number {
  return (
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
    left.id.localeCompare(right.id)
  );
}

function comparatorFor(
  sort: ColumnSortMode,
  column: TaskColumn,
): (left: KanbanTask, right: KanbanTask) => number {
  if (sort === "created") {
    return compareByCreated;
  }
  if (sort === "deadline") {
    return compareByDeadline;
  }
  if (sort === "priority") {
    return compareByPriority;
  }
  if (sort === "title") {
    return compareByTitle;
  }
  return compareByRecency(column);
}

// The search/filter/arrangement state of a single column's toolbar. Each column
// owns its own copy — the board no longer has one shared toolbar. `manualOrder`
// is off by default (recency ordering) and flips on once the user drags a card
// within the column; it lives only for the session (it is never persisted).
export interface ColumnControls {
  query: string;
  manualOrder: boolean;
  sort: ColumnSortMode;
}

export const EMPTY_COLUMN_CONTROLS: ColumnControls = {
  query: "",
  manualOrder: false,
  sort: DEFAULT_COLUMN_SORT,
};

// Per-column controls, keyed by column. A missing entry means "untouched"
// (empty query, recency order, no filter).
export type ColumnControlsMap = Partial<Record<TaskColumn, ColumnControls>>;

export function buildColumnModels(
  board: TaskBoard | null,
  // Kept in the signature (callers still pass the project's single list id) but
  // no longer used to narrow the board — see the filter below.
  _folderId: string,
  controls?: ColumnControlsMap,
): KanbanColumnModel[] {
  return KANBAN_COLUMNS.map((column) => {
    const control = controls?.[column] ?? EMPTY_COLUMN_CONTROLS;
    const needle = control.query.trim();
    let compare: (left: KanbanTask, right: KanbanTask) => number;
    if (control.manualOrder) {
      compare = compareByManualOrder;
    } else if (column === "notes" && control.sort === DEFAULT_COLUMN_SORT) {
      // Draft notes lead by importance + deadline unless the user picks a sort.
      compare = compareNotes;
    } else {
      compare = comparatorFor(control.sort, column);
    }
    return {
      column,
      tasks: (board?.tasks ?? [])
        .filter(
          (task) =>
            // Folders are gone from the product: one project, one list. The
            // folderId is still carried by persisted tasks (and by older boards
            // that had several folders), so every task of the project shows up
            // here regardless of which folder it was filed under.
            task.column === column &&
            // Agent-proposed tasks awaiting the user's validation NEVER surface
            // in a column — they live only in the chat approval tray until the
            // user approves them (which clears the pending state) or refuses
            // them (which deletes them). This is the impérative rule: a proposal
            // must never auto-land in "À faire".
            task.approval?.state !== "pending" &&
            (needle === "" || matchesQuery(task, needle)),
        )
        .sort(compare),
    };
  });
}

export interface SortLabels {
  title: string;
  modes: Record<ColumnSortMode, string>;
}

export function useSortLabels(): SortLabels {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      title: t("tasks.sortTasks"),
      modes: {
        updated: t("tasks.sort.updated"),
        created: t("tasks.sort.created"),
        deadline: t("tasks.sort.deadline"),
        priority: t("tasks.sort.priority"),
        title: t("tasks.sort.title"),
      },
    }),
    [t],
  );
}

export function useColumnLabels(): Record<TaskColumn, string> {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      notes: t("tasks.columns.notes"),
      backlog: t("tasks.columns.backlog"),
      validated: t("tasks.columns.validated"),
      scheduled: t("tasks.columns.scheduled"),
      in_progress: t("tasks.columns.inProgress"),
      done: t("tasks.columns.done"),
      deployed: t("tasks.columns.deployed"),
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
  onDeleteTask: (taskId: string) => void;
  // Node rendered at the top of one column's body (inline new-task draft).
  columnExtras?: { column: TaskColumn; node: React.ReactNode } | null;
}

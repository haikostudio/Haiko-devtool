import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { KanbanTask, TaskBoard, TaskColumn } from "@/data/tasks";
import { daysUntil, parseTaskTags, type TaskPriorityLevel } from "./task-tags";

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
// Faceted filter (the funnel button): narrow the board by priority, deadline,
// and thematic tags. Facets combine as AND (a card must clear every active
// facet); values within a facet combine as OR (any selected tag is enough).
// ---------------------------------------------------------------------------

// The priority levels the filter offers — the same three the editor writes.
// "other"-level priorities (unrecognized suffixes) are never a filter target.
export type FilterPriorityLevel = Exclude<TaskPriorityLevel, "other">;

export type DeadlineFilter = "overdue" | "none";

export interface TaskFilter {
  priorities: FilterPriorityLevel[];
  deadline: DeadlineFilter[];
  tags: string[];
}

export const EMPTY_TASK_FILTER: TaskFilter = { priorities: [], deadline: [], tags: [] };

export function taskFilterCount(filter: TaskFilter): number {
  return filter.priorities.length + filter.deadline.length + filter.tags.length;
}

// The facets actually present on this folder's board, so the filter menu only
// offers choices that can match something (no empty "Low priority" row when no
// card is tagged low). Priorities keep high→low order; tags sort alphabetically.
export interface BoardFacets {
  priorities: FilterPriorityLevel[];
  hasDeadlines: boolean;
  tags: string[];
}

const PRIORITY_FILTER_ORDER: FilterPriorityLevel[] = ["high", "medium", "low"];

export function collectBoardFacets(
  board: TaskBoard | null,
  folderId: string,
  // Scope the facets to a single column so each column's filter menu only
  // offers priorities/tags that can actually match a card sitting in it.
  column?: TaskColumn,
): BoardFacets {
  const priorities = new Set<FilterPriorityLevel>();
  const tags = new Set<string>();
  let hasDeadlines = false;
  for (const task of board?.tasks ?? []) {
    if (task.folderId !== folderId) {
      continue;
    }
    if (column && task.column !== column) {
      continue;
    }
    const parsed = parseTaskTags(task.tags);
    if (parsed.priority && parsed.priority.level !== "other") {
      priorities.add(parsed.priority.level);
    }
    if (parsed.deadline) {
      hasDeadlines = true;
    }
    for (const tag of parsed.tags) {
      tags.add(tag);
    }
  }
  return {
    priorities: PRIORITY_FILTER_ORDER.filter((level) => priorities.has(level)),
    hasDeadlines,
    tags: [...tags].sort((left, right) =>
      left.localeCompare(right, undefined, { sensitivity: "base" }),
    ),
  };
}

function matchesFilter(task: KanbanTask, filter: TaskFilter, now: Date): boolean {
  if (filter.priorities.length === 0 && filter.deadline.length === 0 && filter.tags.length === 0) {
    return true;
  }
  const parsed = parseTaskTags(task.tags);
  if (filter.priorities.length > 0) {
    const level = parsed.priority?.level;
    if (!level || level === "other" || !filter.priorities.includes(level)) {
      return false;
    }
  }
  if (filter.deadline.length > 0) {
    const dueDate = parsed.deadline?.dueDate ?? null;
    const passesDeadline = filter.deadline.some((cond) =>
      cond === "none" ? !parsed.deadline : dueDate !== null && daysUntil(dueDate, now) < 0,
    );
    if (!passesDeadline) {
      return false;
    }
  }
  if (filter.tags.length > 0) {
    if (!parsed.tags.some((tag) => filter.tags.includes(tag))) {
      return false;
    }
  }
  return true;
}

// The search/filter/arrangement state of a single column's toolbar. Each column
// owns its own copy — the board no longer has one shared toolbar. `manualOrder`
// is off by default (recency ordering) and flips on once the user drags a card
// within the column; it lives only for the session (it is never persisted).
export interface ColumnControls {
  query: string;
  manualOrder: boolean;
  filter: TaskFilter;
}

export const EMPTY_COLUMN_CONTROLS: ColumnControls = {
  query: "",
  manualOrder: false,
  filter: EMPTY_TASK_FILTER,
};

// Per-column controls, keyed by column. A missing entry means "untouched"
// (empty query, recency order, no filter).
export type ColumnControlsMap = Partial<Record<TaskColumn, ColumnControls>>;

export function buildColumnModels(
  board: TaskBoard | null,
  folderId: string,
  controls?: ColumnControlsMap,
  // Injected so the "overdue" deadline facet is deterministic in tests.
  now: Date = new Date(),
): KanbanColumnModel[] {
  return KANBAN_COLUMNS.map((column) => {
    const control = controls?.[column] ?? EMPTY_COLUMN_CONTROLS;
    const needle = control.query.trim();
    let compare: (left: KanbanTask, right: KanbanTask) => number;
    if (control.manualOrder) {
      compare = compareByManualOrder;
    } else if (column === "notes") {
      // Draft notes lead by importance + deadline, not raw recency.
      compare = compareNotes;
    } else {
      compare = compareByRecency(column);
    }
    return {
      column,
      tasks: (board?.tasks ?? [])
        .filter(
          (task) =>
            task.folderId === folderId &&
            task.column === column &&
            (needle === "" || matchesQuery(task, needle)) &&
            matchesFilter(task, control.filter, now),
        )
        .sort(compare),
    };
  });
}

export interface FilterLabels {
  title: string;
  empty: string;
  clear: string;
  priorityHeading: string;
  deadlineHeading: string;
  tagsHeading: string;
  priority: Record<FilterPriorityLevel, string>;
  deadline: Record<DeadlineFilter, string>;
}

export function useFilterLabels(): FilterLabels {
  const { t } = useTranslation();
  return useMemo(
    () => ({
      title: t("tasks.filter.title"),
      empty: t("tasks.filter.empty"),
      clear: t("tasks.filter.clear"),
      priorityHeading: t("tasks.filter.priorityHeading"),
      deadlineHeading: t("tasks.filter.deadlineHeading"),
      tagsHeading: t("tasks.filter.tagsHeading"),
      priority: {
        high: t("tasks.filter.priorityHigh"),
        medium: t("tasks.filter.priorityMedium"),
        low: t("tasks.filter.priorityLow"),
      },
      deadline: {
        overdue: t("tasks.filter.deadlineOverdue"),
        none: t("tasks.filter.deadlineNone"),
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
  // Node rendered at the top of one column's body (inline new-task draft).
  columnExtras?: { column: TaskColumn; node: React.ReactNode } | null;
}

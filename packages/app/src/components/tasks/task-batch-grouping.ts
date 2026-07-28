// Cards that belong to the same lot ("N sur M" in the title, or a shared
// "lot-…" tag) stack into a single compact row in their column instead of
// eating the whole height. Detection lives here — pure and unit-tested — so the
// two boards (web dnd-kit + scrollable touch) share one rule.
//
// The key deliberately combines several hints: a bare "3" in a title is not a
// lot, and two unrelated 5-card lots in different folders must not merge.

import type { KanbanTask } from "@/data/tasks";

export interface BatchMarker {
  /** 1-based position inside the lot. */
  index: number;
  /** Total number of cards the title claims the lot has. */
  total: number;
}

// A lot never realistically exceeds a couple dozen cards; capping the total
// keeps years ("2 sur 2026") and quantities ("12 sur 300 lignes") out.
const MAX_BATCH_TOTAL = 30;

// "2 sur 5", "2/5", "2 of 5" — the separator set the conductor actually writes.
// Boundaries are explicit so "15/07/26" (a date) and "v2 sur" (truncated) never
// match: the marker must be delimited by start/end, whitespace, or one of the
// usual wrappers.
const MARKER_PATTERN = /(^|[\s([\-—·#])(\d{1,2})\s*(?:sur|\/|of)\s*(\d{1,2})($|[\s)\]\-—·,.:;])/gi;

// The trailing marker is usually wrapped — "(2 sur 5)" / "[2/5]" — so a wrapped
// match wins over a bare one when a title happens to contain both.
const WRAPPERS = new Set(["(", "[", ")", "]"]);

/**
 * Read the "N sur M" lot marker out of a task title. Returns null when the
 * title carries no plausible marker (no match, or an impossible one such as
 * "7 sur 3").
 */
export function parseBatchMarker(title: string): BatchMarker | null {
  let fallback: BatchMarker | null = null;
  for (const match of title.matchAll(MARKER_PATTERN)) {
    const index = Number(match[2]);
    const total = Number(match[3]);
    if (total < 2 || total > MAX_BATCH_TOTAL || index < 1 || index > total) {
      continue;
    }
    const marker = { index, total };
    if (WRAPPERS.has(match[1]) || WRAPPERS.has(match[4])) {
      return marker;
    }
    // No wrapper: keep the last plausible one — the convention puts the
    // numbering at the end of the title.
    fallback = marker;
  }
  return fallback;
}

// Explicit lot tags the agents may emit: "lot-refonte-tableau", "batch: auth",
// "série-2". They group cards that share a need even when the titles carry no
// numbering at all.
const LOT_TAG_PATTERN = /^(?:lots?|batch|s[eé]ries?)[-:\s]+(.+)$/i;

function normalizeTagValue(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[-_\s]+/g, " ")
    .trim()
    .toLowerCase();
}

/** The normalized suffix of the card's explicit lot tag, or null. */
export function parseBatchTag(tags: readonly string[]): string | null {
  for (const tag of tags) {
    const match = LOT_TAG_PATTERN.exec(tag.trim());
    if (match) {
      const value = normalizeTagValue(match[1]);
      if (value) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Grouping key for a card, or null when it belongs to no lot. An explicit lot
 * tag wins over the title numbering (it is the stronger, hand-authored signal);
 * numbering alone falls back to "same folder + same total".
 */
export function batchKeyForTask(task: KanbanTask): string | null {
  const tag = parseBatchTag(task.tags);
  if (tag) {
    return `tag:${task.folderId}:${tag}`;
  }
  const marker = parseBatchMarker(task.title);
  if (marker) {
    return `num:${task.folderId}:${marker.total}`;
  }
  return null;
}

export type BoardRow =
  | { kind: "task"; key: string; task: KanbanTask }
  | { kind: "batch"; key: string; tasks: KanbanTask[] };

// Numbered cards lead in "1, 2, 3…" order; unnumbered members of a tagged lot
// sink below them, keeping their column order.
function compareInsideBatch(left: KanbanTask, right: KanbanTask): number {
  const leftIndex = parseBatchMarker(left.title)?.index ?? Number.POSITIVE_INFINITY;
  const rightIndex = parseBatchMarker(right.title)?.index ?? Number.POSITIVE_INFINITY;
  return leftIndex - rightIndex;
}

/**
 * Turn a column's ordered task list into rows: lone cards stay as they are,
 * cards sharing a lot key collapse into one batch row placed where the lot's
 * first card sat (so the column's recency / manual ordering still drives the
 * layout). A "lot" of one is not a lot — it renders as a plain card.
 */
export function groupTasksIntoBoardRows(tasks: readonly KanbanTask[]): BoardRow[] {
  const byKey = new Map<string, KanbanTask[]>();
  const keys = tasks.map((task) => batchKeyForTask(task));
  for (const [position, key] of keys.entries()) {
    if (!key) {
      continue;
    }
    const bucket = byKey.get(key);
    const task = tasks[position];
    if (bucket) {
      bucket.push(task);
    } else {
      byKey.set(key, [task]);
    }
  }

  const rows: BoardRow[] = [];
  const emitted = new Set<string>();
  for (const [position, task] of tasks.entries()) {
    const key = keys[position];
    const bucket = key ? byKey.get(key) : undefined;
    if (!key || !bucket || bucket.length < 2) {
      rows.push({ kind: "task", key: task.id, task });
      continue;
    }
    if (emitted.has(key)) {
      continue;
    }
    emitted.add(key);
    // Stable sort: same-index members keep their column order.
    rows.push({ kind: "batch", key, tasks: [...bucket].sort(compareInsideBatch) });
  }
  return rows;
}

/**
 * The task ids a column actually renders, in render order — a collapsed batch
 * only exposes its lead card. The web board feeds this to dnd-kit so a hidden
 * card is never a drag/drop target while it is tucked inside the stack.
 */
export function visibleTaskIds(rows: readonly BoardRow[], isExpanded: (key: string) => boolean) {
  const ids: string[] = [];
  for (const row of rows) {
    if (row.kind === "task") {
      ids.push(row.task.id);
    } else if (isExpanded(row.key)) {
      ids.push(...row.tasks.map((task) => task.id));
    } else {
      ids.push(row.tasks[0].id);
    }
  }
  return ids;
}

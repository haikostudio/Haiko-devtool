import type { PushHistoryEntry } from "@getpaseo/protocol/messages";

/** Above this the badge shows "N+" instead of a number that no longer fits. */
export const UNREAD_BADGE_MAX = 99;

/**
 * How many notifications arrived after the panel was last opened.
 *
 * `lastOpenedAt` is null before the read marker is seeded (fresh install): the
 * badge stays at zero rather than announcing a backlog the user never asked
 * about. Entries with no usable timestamp are ignored — an unreadable date
 * cannot be proven to be new.
 */
export function countUnreadNotifications(
  entries: readonly PushHistoryEntry[] | null,
  lastOpenedAt: number | null,
): number {
  if (!entries || entries.length === 0 || lastOpenedAt === null) {
    return 0;
  }
  let count = 0;
  for (const entry of entries) {
    if (Number.isFinite(entry.sentAt) && entry.sentAt > lastOpenedAt) {
      count += 1;
    }
  }
  return count;
}

/** Badge text, capped so the pill keeps its size. */
export function formatUnreadBadge(count: number): string {
  return count > UNREAD_BADGE_MAX ? `${UNREAD_BADGE_MAX}+` : String(count);
}

export interface NotificationRowModel {
  id: string;
  /** Task the notification is about — falls back to the push title. */
  taskTitle: string;
  /** Project the task belongs to, or null when the daemon did not report one. */
  projectName: string | null;
  /** Short recap (max 3 sentences), or null when there is nothing to add. */
  summary: string | null;
  sentAt: number;
}

/**
 * Turn a wire entry into the four things a row shows: task, project, time and
 * recap.
 *
 * Older daemons record only title/body, so the row degrades to exactly what the
 * previous panel showed — title on top, body underneath — instead of going
 * blank. The body is dropped when it merely repeats the recap.
 */
export function toNotificationRowModel(entry: PushHistoryEntry): NotificationRowModel {
  const taskTitle = firstNonEmpty(entry.taskTitle, entry.title) ?? "";
  const summary = firstNonEmpty(entry.summary, entry.body);
  return {
    id: entry.id,
    taskTitle,
    projectName: firstNonEmpty(entry.projectName) ?? null,
    summary: summary && summary !== taskTitle ? summary : null,
    sentAt: entry.sentAt,
  };
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

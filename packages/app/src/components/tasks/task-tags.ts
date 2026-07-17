// Task cards carry structured metadata as prefixed strings that the brain /
// agent-sync emits into the flat `tags[]` array — e.g. "priorité-haute" and
// "échéance-15.07.26". The card lifts the priority flag and the deadline out of
// that list and renders whatever is left as plain thematic chips. Parsing lives
// here (not inline in the card) so it stays pure and unit-testable.

export type TaskPriorityLevel = "high" | "medium" | "low" | "other";

export interface ParsedPriority {
  level: TaskPriorityLevel;
  /** Display text — the tag suffix as authored, e.g. "haute". */
  label: string;
}

export interface ParsedDeadline {
  /** Display text — the raw date ("15.07.26") or a humanized value ("à définir"). */
  label: string;
  /** Parsed calendar date when the suffix is a recognizable date, else null. */
  dueDate: Date | null;
}

export interface ParsedTaskTags {
  priority: ParsedPriority | null;
  deadline: ParsedDeadline | null;
  /** Thematic tags left after pulling out priority + deadline. */
  tags: string[];
}

// Prefixes are matched loosely (accents optional, EN + FR) because the tag text
// is agent-authored data, not UI chrome under our control.
const PRIORITY_PREFIX = /^(?:priorit[eé]s?|priority)[-:\s]+(.+)$/i;
const DEADLINE_PREFIX = /^(?:[eé]ch[eé]ance|deadline|due(?:[-\s]?date)?)[-:\s]+(.+)$/i;
const DATE_PATTERN = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/;

const MS_PER_DAY = 86_400_000;

function priorityLevel(value: string): TaskPriorityLevel {
  const normalized = value.toLowerCase();
  if (/haute|élev|elev|urgent|high|p0|p1/.test(normalized)) {
    return "high";
  }
  if (/moyen|normal|medium|p2/.test(normalized)) {
    return "medium";
  }
  if (/basse|faible|low|bas|p3|p4/.test(normalized)) {
    return "low";
  }
  return "other";
}

function humanize(value: string): string {
  return value.replace(/[-_]+/g, " ").trim();
}

/**
 * Parse a deadline suffix such as "15.07.26" or "31/12/2026" into a Date at
 * local midnight. Returns null for non-dates ("à-définir") or impossible dates
 * ("31.02.26") — JS Date silently rolls those over, so we validate the parts.
 */
export function parseDeadlineDate(value: string): Date | null {
  const match = DATE_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) {
    year += 2000;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date;
}

export function parseTaskTags(tags: readonly string[]): ParsedTaskTags {
  let priority: ParsedPriority | null = null;
  let deadline: ParsedDeadline | null = null;
  const rest: string[] = [];

  for (const tag of tags) {
    const prioritySuffix = PRIORITY_PREFIX.exec(tag)?.[1];
    if (!priority && prioritySuffix) {
      const label = humanize(prioritySuffix);
      priority = { level: priorityLevel(label), label };
      continue;
    }

    const deadlineSuffix = DEADLINE_PREFIX.exec(tag)?.[1];
    if (!deadline && deadlineSuffix) {
      const raw = deadlineSuffix.trim();
      const dueDate = parseDeadlineDate(raw);
      deadline = { label: dueDate ? raw : humanize(raw), dueDate };
      continue;
    }

    rest.push(tag);
  }

  return { priority, deadline, tags: rest };
}

/**
 * Whole-day difference from `from` to `to`, ignoring time-of-day. Positive =
 * days remaining, 0 = due today, negative = overdue.
 */
export function daysUntil(to: Date, from: Date): number {
  const startTo = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  const startFrom = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.round((startTo - startFrom) / MS_PER_DAY);
}

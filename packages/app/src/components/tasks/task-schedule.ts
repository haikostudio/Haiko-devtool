// Client-side mirror of the server task scheduler's quiet-hours gate
// (packages/server/src/server/quiet-hours.ts + scheduler.ts). It lets a card
// answer "when will this validated task actually run?" without a new RPC: the
// daemon config carries the quiet-hours window, and the same light/heavy split
// the scheduler uses decides whether a task waits for the next off-peak window.
import type { KanbanTask } from "@/data/tasks";

export interface QuietHours {
  /** Local hour (0-23) at which the off-peak window opens, inclusive. */
  startHour: number;
  /** Local hour (0-23) at which it closes, exclusive. */
  endHour: number;
  /** IANA timezone the hours are interpreted in. */
  timeZone: string;
}

/** Matches DEFAULT_TASKS_QUIET_HOURS on the server (user typically asleep 01:00–07:00). */
export const DEFAULT_TASKS_QUIET_HOURS: QuietHours = {
  startHour: 1,
  endHour: 7,
  timeZone: "Europe/Paris",
};

// Mirror of the scheduler's "light task" thresholds: a task under both may run
// outside quiet hours in "auto" mode; anything heavier waits for the window.
const LIGHT_TASK_MAX_QUOTA_PCT = 25;
const LIGHT_TASK_MAX_MINUTES = 45;

// Local wall-clock hour/minute/second in the given timezone.
function localTimeParts(nowMs: number, timeZone: string): { hour: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { hour: read("hour") % 24, minutes: read("minute") };
}

/** True when the instant falls inside the quiet-hours window. */
export function isQuietTime(nowMs: number, quietHours: QuietHours): boolean {
  const { startHour, endHour, timeZone } = quietHours;
  if (startHour === endHour) {
    return false;
  }
  const { hour } = localTimeParts(nowMs, timeZone);
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

/**
 * Epoch ms of the next moment the quiet-hours window opens. If already inside
 * the window it returns `nowMs` (a heavy task can launch right away). Ignores
 * DST edges — close enough for a "runs around 01:00" hint.
 */
export function nextQuietHoursStartMs(nowMs: number, quietHours: QuietHours): number {
  if (isQuietTime(nowMs, quietHours)) {
    return nowMs;
  }
  const { hour, minutes } = localTimeParts(nowMs, quietHours.timeZone);
  let hoursUntil = quietHours.startHour - hour;
  if (hoursUntil <= 0) {
    hoursUntil += 24;
  }
  return nowMs + hoursUntil * 3_600_000 - minutes * 60_000;
}

/**
 * Whether a pipeline task (Validé/Planifié) will wait for the off-peak window
 * before it launches, mirroring the scheduler's decision. "asap" never waits,
 * "off_peak" always does, and "auto" (default) waits only for heavy tasks.
 */
export function waitsForOffPeak(task: KanbanTask): boolean {
  if (task.schedule?.waitingReason === "quiet_hours") {
    return true;
  }
  const preference = task.schedulePreference ?? "auto";
  if (preference === "asap") {
    return false;
  }
  if (preference === "off_peak") {
    return true;
  }
  const quotaPercent = task.estimate?.quotaPercent ?? 0;
  const minutes = task.estimate?.estimatedMinutes ?? 0;
  const isLight = quotaPercent < LIGHT_TASK_MAX_QUOTA_PCT && minutes < LIGHT_TASK_MAX_MINUTES;
  return !isLight;
}

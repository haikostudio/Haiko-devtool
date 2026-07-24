export interface QuietHours {
  /** Local hour (0-23) at which the window opens, inclusive. */
  startHour: number;
  /** Local hour (0-23) at which the window closes, exclusive. */
  endHour: number;
  /** IANA timezone the hours are interpreted in. */
  timeZone: string;
}

/** Default off-peak window for the task scheduler (user typically asleep 01:00–07:00). */
export const DEFAULT_TASKS_QUIET_HOURS: QuietHours = {
  startHour: 1,
  endHour: 7,
  timeZone: "Europe/Paris",
};

/** True when the given instant falls inside the quiet-hours window. */
export function isQuietTime(nowMs: number, quietHours: QuietHours): boolean {
  const { startHour, endHour, timeZone } = quietHours;
  if (startHour === endHour) {
    return false;
  }
  const hour =
    Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone,
        hour: "numeric",
        hour12: false,
      }).format(new Date(nowMs)),
    ) % 24;
  // Handle same-day windows (1–6) and wrap-around windows (23–6) alike.
  return startHour < endHour
    ? hour >= startHour && hour < endHour
    : hour >= startHour || hour < endHour;
}

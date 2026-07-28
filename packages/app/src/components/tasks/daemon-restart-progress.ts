/**
 * How long a daemon restart usually takes before the app is back: the supervisor
 * relaunches the process after a few seconds, then the socket re-handshakes.
 * This is the countdown the user watches — deliberately a little generous, so
 * the common case finishes EARLY (the bar flips to "reconnecté") rather than
 * overrunning a promise that was too optimistic.
 */
export const RESTART_EXPECTED_MS = 10_000;
/**
 * Past this, something is wrong: the daemon did not come back on its own. The
 * bar says so instead of counting into the void.
 */
export const RESTART_TIMEOUT_MS = 60_000;

export type RestartProgress =
  | { state: "idle" }
  /** Counting down to the expected reconnection — `secondsLeft` is 1..10. */
  | { state: "counting"; secondsLeft: number }
  /** The estimate ran out and the socket is still down: keep waiting, quietly. */
  | { state: "reconnecting" }
  /** Long past the estimate: the daemon has not come back. */
  | { state: "timeout" };

/**
 * What the restart bar should say right now. Pure — the wording rule is
 * unit-tested without timers, sockets or a render.
 *
 * `reconnected` is NOT simply "the socket is up": right after the request the
 * old connection is still alive for a moment, so the caller only passes true
 * once it has seen the connection drop AND come back. Otherwise the countdown
 * would end instantly, before the daemon had even stopped.
 */
export function describeRestartProgress(input: {
  startedAtMs: number | null;
  nowMs: number;
  reconnected: boolean;
}): RestartProgress {
  const { startedAtMs, nowMs, reconnected } = input;
  if (startedAtMs === null || reconnected) {
    return { state: "idle" };
  }
  const elapsed = Math.max(0, nowMs - startedAtMs);
  if (elapsed >= RESTART_TIMEOUT_MS) {
    return { state: "timeout" };
  }
  if (elapsed >= RESTART_EXPECTED_MS) {
    return { state: "reconnecting" };
  }
  // Ceil so the first tick reads "10 s" and the last one reads "1 s" — a
  // countdown that shows 0 while still waiting reads as a stall.
  return { state: "counting", secondsLeft: Math.ceil((RESTART_EXPECTED_MS - elapsed) / 1000) };
}

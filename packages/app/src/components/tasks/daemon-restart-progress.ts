/**
 * Grace period between "yes, restart" and the request actually leaving. It is
 * the undo window: a restart cuts every running agent, and the half-second of
 * doubt right after pressing is exactly when people want to take it back.
 */
export const RESTART_ARMING_MS = 5_000;
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
  /** Armed but not sent yet — `secondsLeft` is the undo window still open. */
  | { state: "arming"; secondsLeft: number }
  /** Counting down to the expected reconnection — `secondsLeft` is 1..10. */
  | { state: "counting"; secondsLeft: number }
  /** The estimate ran out and the socket is still down: keep waiting, quietly. */
  | { state: "reconnecting" }
  /** Long past the estimate: the daemon has not come back. */
  | { state: "timeout" };

/** Whole seconds still to run, never 0 while waiting (0 reads as a stall). */
function secondsLeft(remainingMs: number): number {
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/**
 * What the restart bar should say right now. Pure — the wording rule is
 * unit-tested without timers, sockets or a render.
 *
 * `armedAtMs` is set the moment the user says yes and cleared when the request
 * goes out; `startedAtMs` is set when it goes out. The two never overlap, so the
 * bar reads "Annuler (3 s)" then "Reconnexion dans 8 s…".
 *
 * `reconnected` is NOT simply "the socket is up": right after the request the
 * old connection is still alive for a moment, so the caller only passes true
 * once it has seen the connection drop AND come back. Otherwise the countdown
 * would end instantly, before the daemon had even stopped.
 */
export function describeRestartProgress(input: {
  armedAtMs?: number | null;
  startedAtMs: number | null;
  nowMs: number;
  reconnected: boolean;
}): RestartProgress {
  const { armedAtMs = null, startedAtMs, nowMs, reconnected } = input;
  if (startedAtMs === null && armedAtMs !== null) {
    const remaining = RESTART_ARMING_MS - Math.max(0, nowMs - armedAtMs);
    // Out of undo time: the request is about to leave, so stop offering it.
    return remaining <= 0
      ? { state: "counting", secondsLeft: secondsLeft(RESTART_EXPECTED_MS) }
      : { state: "arming", secondsLeft: secondsLeft(remaining) };
  }
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
  return { state: "counting", secondsLeft: secondsLeft(RESTART_EXPECTED_MS - elapsed) };
}

/** True while the restart can still be taken back. */
export function isRestartCancellable(progress: RestartProgress): boolean {
  return progress.state === "arming";
}

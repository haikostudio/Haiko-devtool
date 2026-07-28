import { create } from "zustand";

/**
 * The one place that knows a daemon restart is in flight, and whether one was
 * promised for after a publication.
 *
 * It is a store rather than component state because several surfaces need the
 * same truth: the card's restart bar (which shows the countdown), the watcher
 * that drives the clock, and the one that fires a chained restart once a
 * publication lands. Two copies would let the bar sit idle while a restart it
 * started was running — or fire two "moteur redémarré" toasts.
 *
 * Deliberately NOT persisted: an in-flight restart is meaningless after a
 * reload, and a promise to restart "after this publication" must never survive
 * the session that made it.
 */
interface DaemonRestartState {
  /** When the current restart was requested, or null when none is in flight. */
  startedAtMs: number | null;
  /** Clock the countdown reads, ticked by the watcher while a restart runs. */
  nowMs: number;
  /**
   * True once the connection has been seen to DROP since `startedAtMs` — the
   * old socket stays up for a moment after the request, so this is what makes
   * "the daemon came back" honest rather than instant.
   */
  sawDisconnect: boolean;
  /** True once the connection dropped and returned: the restart is over. */
  reconnected: boolean;
  /**
   * Card whose publication the user asked to chain a restart onto. The watcher
   * fires the restart when that card goes live, then clears this.
   */
  restartAfterDeployTaskId: string | null;
  begin: (startedAtMs: number) => void;
  tick: (nowMs: number) => void;
  markDisconnected: () => void;
  markReconnected: () => void;
  clear: () => void;
  setRestartAfterDeploy: (taskId: string | null) => void;
}

export const useDaemonRestartStore = create<DaemonRestartState>((set) => ({
  startedAtMs: null,
  nowMs: 0,
  sawDisconnect: false,
  reconnected: false,
  restartAfterDeployTaskId: null,
  begin: (startedAtMs) =>
    set({ startedAtMs, nowMs: startedAtMs, sawDisconnect: false, reconnected: false }),
  tick: (nowMs) => set({ nowMs }),
  markDisconnected: () => set({ sawDisconnect: true }),
  markReconnected: () => set({ reconnected: true }),
  clear: () => set({ startedAtMs: null, sawDisconnect: false, reconnected: false }),
  setRestartAfterDeploy: (restartAfterDeployTaskId) => set({ restartAfterDeployTaskId }),
}));

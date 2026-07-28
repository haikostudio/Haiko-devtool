import { create } from "zustand";

/** One agent whose turn a restart cut short, captured just before the request. */
export interface InterruptedAgent {
  agentId: string;
  /** What it was trying to achieve, so the resume prompt can name it. */
  objective: string | null;
}

/**
 * The one place that knows a daemon restart is in flight, and everything that
 * hangs off it.
 *
 * It is a store rather than component state because several surfaces need the
 * same truth: the card's restart bar (countdown + undo), the settings host page,
 * the watcher that drives the clock, and the one that fires a chained restart
 * once a publication lands. Two copies would let the bar sit idle while a
 * restart it started was running — or fire two "moteur redémarré" toasts.
 *
 * Deliberately NOT persisted: an in-flight restart is meaningless after a
 * reload, and a promise to restart "after this publication" must never survive
 * the session that made it. (The user's *preference* for chaining them does
 * persist — that lives in the board UI store.)
 */
interface DaemonRestartState {
  /**
   * Host being restarted. Recorded when arming so the app-root watcher keeps
   * targeting the right daemon even if the user navigates away from the screen
   * that fired it.
   */
  serverId: string | null;
  /**
   * When the user said yes, during the undo window. The request has NOT left
   * yet: cancelling here costs nothing. Cleared when it goes out.
   */
  armedAtMs: number | null;
  /** When the request actually left, or null when none is in flight. */
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
  /** Agents cut mid-turn by this restart, replayed once the daemon is back. */
  interrupted: InterruptedAgent[];
  /**
   * Card whose publication the user asked to chain a restart onto. The watcher
   * fires the restart when that card goes live, then clears this.
   */
  restartAfterDeployTaskId: string | null;
  arm: (input: {
    serverId: string | null;
    armedAtMs: number;
    interrupted: InterruptedAgent[];
  }) => void;
  begin: (startedAtMs: number) => void;
  tick: (nowMs: number) => void;
  markDisconnected: () => void;
  markReconnected: () => void;
  clear: () => void;
  clearInterrupted: () => void;
  setRestartAfterDeploy: (taskId: string | null) => void;
}

const IDLE = {
  serverId: null,
  armedAtMs: null,
  startedAtMs: null,
  sawDisconnect: false,
  reconnected: false,
} as const;

export const useDaemonRestartStore = create<DaemonRestartState>((set) => ({
  ...IDLE,
  nowMs: 0,
  interrupted: [],
  restartAfterDeployTaskId: null,
  arm: ({ serverId, armedAtMs, interrupted }) =>
    set({ ...IDLE, serverId, armedAtMs, nowMs: armedAtMs, interrupted }),
  begin: (startedAtMs) =>
    set({ armedAtMs: null, startedAtMs, nowMs: startedAtMs, sawDisconnect: false }),
  tick: (nowMs) => set({ nowMs }),
  markDisconnected: () => set({ sawDisconnect: true }),
  markReconnected: () => set({ reconnected: true }),
  // Cancelling (or settling) drops the interrupted list too: nothing was cut, so
  // there is nothing to resume.
  clear: () => set({ ...IDLE, interrupted: [] }),
  clearInterrupted: () => set({ interrupted: [] }),
  setRestartAfterDeploy: (restartAfterDeployTaskId) => set({ restartAfterDeployTaskId }),
}));

import type pino from "pino";
import { getDaemonRestartDebt, type DaemonRestartDebt } from "../../utils/paseo-deploy.js";

/** How often the debt is re-read. Cheap (two git calls), so a slow poll is fine. */
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;
/**
 * How long shipped-but-dormant daemon code may sit before the user is nudged.
 * Long enough that a restart the user is about to do anyway never gets nagged,
 * short enough that "I published hours ago and nothing changed" cannot happen.
 */
const DEFAULT_GRACE_MS = 2 * 60 * 60 * 1000;

export interface RestartReminderState {
  /** HEAD the current debt refers to, or null when the daemon is up to date. */
  debtSha: string | null;
  /** When that debt was first observed. */
  debtSinceMs: number | null;
  /** True once a reminder went out for `debtSha`. */
  notified: boolean;
}

export const NO_RESTART_DEBT: RestartReminderState = {
  debtSha: null,
  debtSinceMs: null,
  notified: false,
};

export interface RestartReminderDecision {
  state: RestartReminderState;
  /** Set when a reminder must go out now. */
  notify: { commitCount: number; headSha: string } | null;
}

/**
 * Should the user be nudged to restart the daemon? Pure, so the (fiddly) "once
 * per HEAD, only after the grace period" rule is unit-tested without git, a
 * clock or a push service.
 *
 * The rules, in order:
 * - No debt (daemon runs current code) → forget everything. A restart resets the
 *   state, so the NEXT publication gets its own reminder.
 * - A different HEAD than the one we were counting → restart the grace clock.
 *   Fresh work deserves a fresh countdown, not the previous one's leftovers.
 * - Debt younger than the grace period → stay quiet.
 * - Already reminded for this HEAD → stay quiet. One nudge per publication; the
 *   card's own "Redémarrer le moteur" bar is always there for the rest.
 */
export function decideRestartReminder(input: {
  debt: DaemonRestartDebt;
  state: RestartReminderState;
  nowMs: number;
  graceMs?: number;
}): RestartReminderDecision {
  const { debt, state, nowMs } = input;
  const graceMs = input.graceMs ?? DEFAULT_GRACE_MS;
  if (debt.commitCount === 0 || debt.headSha === null) {
    return { state: NO_RESTART_DEBT, notify: null };
  }
  if (state.debtSha !== debt.headSha) {
    // New (or newly seen) debt: start its own countdown, say nothing yet.
    return {
      state: { debtSha: debt.headSha, debtSinceMs: nowMs, notified: false },
      notify: null,
    };
  }
  const waited = nowMs - (state.debtSinceMs ?? nowMs);
  if (state.notified || waited < graceMs) {
    return { state, notify: null };
  }
  return {
    state: { ...state, notified: true },
    notify: { commitCount: debt.commitCount, headSha: debt.headSha },
  };
}

export interface DaemonRestartReminderOptions {
  sendPush: (payload: { title: string; body: string; data?: Record<string, unknown> }) => void;
  logger: pino.Logger;
  pollIntervalMs?: number;
  graceMs?: number;
  now?: () => number;
  readDebt?: () => Promise<DaemonRestartDebt>;
}

/**
 * Nudges the user when work that is already published stays dormant because the
 * daemon has not been restarted — the failure the card's "Redémarrage requis"
 * pill warns about, caught hours later if the warning was missed.
 *
 * It never restarts anything: a restart is the user's explicit call, and this
 * only makes the pending one visible. One notification per publication.
 */
export class DaemonRestartReminder {
  private readonly sendPush: DaemonRestartReminderOptions["sendPush"];
  private readonly logger: pino.Logger;
  private readonly pollIntervalMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;
  private readonly readDebt: () => Promise<DaemonRestartDebt>;
  private state: RestartReminderState = NO_RESTART_DEBT;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: DaemonRestartReminderOptions) {
    this.sendPush = options.sendPush;
    this.logger = options.logger.child({ module: "daemon-restart-reminder" });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.readDebt = options.readDebt ?? getDaemonRestartDebt;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        this.logger.debug({ err }, "Daemon restart reminder tick failed");
      });
    }, this.pollIntervalMs);
    // Never hold the event loop open just for this poller.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    const debt = await this.readDebt();
    const decision = decideRestartReminder({
      debt,
      state: this.state,
      nowMs: this.now(),
      graceMs: this.graceMs,
    });
    this.state = decision.state;
    if (!decision.notify) {
      return;
    }
    this.logger.info(
      { commitCount: decision.notify.commitCount, headSha: decision.notify.headSha },
      "Published work is waiting on a daemon restart",
    );
    this.sendPush({
      title: "Redémarrage en attente",
      body:
        decision.notify.commitCount === 1
          ? "Une modification publiée n'est pas encore active : le moteur Paseo doit être redémarré."
          : `${decision.notify.commitCount} modifications publiées ne sont pas encore actives : le moteur Paseo doit être redémarré.`,
      data: { type: "daemon_restart_pending", headSha: decision.notify.headSha },
    });
  }
}

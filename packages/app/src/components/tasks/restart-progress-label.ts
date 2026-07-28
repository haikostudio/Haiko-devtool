import type { TFunction } from "i18next";
import type { RestartProgress } from "@/components/tasks/daemon-restart-progress";

/**
 * What a restart control reads at each phase. Shared by the card's bar and the
 * settings host page so a restart says the same thing wherever it was started
 * from — one vocabulary, not two.
 *
 * The countdown is the whole point: an unqualified "Redémarrage en cours…"
 * gives no idea whether to wait two seconds or go make coffee. When the estimate
 * runs out the wording drops the number rather than counting into negatives, and
 * a daemon that never comes back says so instead of pretending.
 *
 * `idleKey` is the label when nothing is happening — the two surfaces name the
 * gesture differently ("Redémarrer le moteur" on a card, "Redémarrer" in the
 * settings row), and only that word differs.
 */
export function restartProgressLabel(
  progress: RestartProgress,
  t: TFunction,
  idleKey: string,
): string {
  if (progress.state === "arming") {
    return t("tasks.panel.restartDaemonUndo", { seconds: progress.secondsLeft });
  }
  if (progress.state === "counting") {
    return t("tasks.panel.restartDaemonCountdown", { seconds: progress.secondsLeft });
  }
  if (progress.state === "reconnecting") {
    return t("tasks.panel.restartDaemonReconnecting");
  }
  if (progress.state === "timeout") {
    return t("tasks.panel.restartDaemonTimeout");
  }
  return t(idleKey);
}

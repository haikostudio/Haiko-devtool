import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { useDaemonRestartStore, type InterruptedAgent } from "@/stores/daemon-restart-store";
import { useToast } from "@/contexts/toast-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  describeRestartProgress,
  type RestartProgress,
} from "@/components/tasks/daemon-restart-progress";

export interface DaemonRestartAction {
  /** Confirms, then arms the restart (the undo window opens). */
  restart: () => Promise<void>;
  /** Arms WITHOUT asking — for a restart the user already agreed to. */
  restartWithoutAsking: () => void;
  /** Takes the restart back, while the undo window is still open. */
  cancel: () => void;
  /** What the bar should say right now (undo, countdown, reconnecting, timed out). */
  progress: RestartProgress;
}

/**
 * Live restart state, derived from the shared store. Effect-free on purpose:
 * several surfaces read it at once, and only {@link DaemonRestartWatcher} is
 * allowed to drive the clock and settle the restart — otherwise every mounted
 * reader would fire its own timer and its own "moteur redémarré" toast.
 */
export function useDaemonRestartProgress(): RestartProgress {
  const armedAtMs = useDaemonRestartStore((state) => state.armedAtMs);
  const startedAtMs = useDaemonRestartStore((state) => state.startedAtMs);
  const reconnected = useDaemonRestartStore((state) => state.reconnected);
  const nowMs = useDaemonRestartStore((state) => state.nowMs);
  return describeRestartProgress({ armedAtMs, startedAtMs, nowMs, reconnected });
}

/** Agents mid-turn right now, with what each was trying to achieve. */
function readRunningAgents(serverId: string | null): InterruptedAgent[] {
  const agents = serverId ? useSessionStore.getState().sessions[serverId]?.agents : undefined;
  if (!agents) {
    return [];
  }
  const running: InterruptedAgent[] = [];
  for (const [agentId, agent] of agents) {
    if (agent.status === "running") {
      running.push({ agentId, objective: agent.synthesis?.objective ?? null });
    }
  }
  return running;
}

/**
 * The card's "Redémarrer le moteur" gesture.
 *
 * Restarting is never silent, and never instant. The confirmation says how many
 * agents are working right now — the daemon is only ever restarted on an
 * explicit, informed go — and pressing it opens a short undo window rather than
 * firing straight away, because the seconds right after "oui" are exactly when
 * people change their mind.
 *
 * `restartWithoutAsking` exists for the one case where the go was already given:
 * the user chose "publier puis redémarrer". It still opens the undo window.
 */
export function useDaemonRestartAction(serverId: string | null): DaemonRestartAction {
  const { t } = useTranslation();
  const toast = useToast();
  const armedAtMs = useDaemonRestartStore((state) => state.armedAtMs);
  const startedAtMs = useDaemonRestartStore((state) => state.startedAtMs);
  const arm = useDaemonRestartStore((state) => state.arm);
  const clear = useDaemonRestartStore((state) => state.clear);
  const progress = useDaemonRestartProgress();
  const inFlight = armedAtMs !== null || startedAtMs !== null;

  // A count, not the agent map: a number keeps this selector stable, so a
  // streaming agent doesn't re-render the whole panel on every token.
  const busyAgentCount = useSessionStore((state) => {
    const agents = serverId ? state.sessions[serverId]?.agents : undefined;
    if (!agents) {
      return 0;
    }
    let count = 0;
    for (const agent of agents.values()) {
      if (agent.status === "running") {
        count += 1;
      }
    }
    return count;
  });

  // Captured HERE, not after the restart: once the daemon is down, there is no
  // one left to ask which agents were mid-turn.
  const armNow = useCallback(() => {
    if (inFlight) {
      return;
    }
    arm({ serverId, armedAtMs: Date.now(), interrupted: readRunningAgents(serverId) });
  }, [inFlight, arm, serverId]);

  const restart = useCallback(async () => {
    if (inFlight) {
      return;
    }
    const confirmed = await confirmDialog({
      title: t("tasks.panel.restartDaemon"),
      message:
        busyAgentCount > 0
          ? t("tasks.panel.restartDaemonBusyMessage", { count: busyAgentCount })
          : t("tasks.panel.restartDaemonMessage"),
      confirmLabel: t("tasks.panel.restartDaemon"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (!confirmed) {
      return;
    }
    armNow();
  }, [inFlight, busyAgentCount, t, armNow]);

  const cancel = useCallback(() => {
    // Only while the request has not left. Past that the button is gone anyway,
    // but a stale press must never clear a real restart's countdown.
    if (useDaemonRestartStore.getState().startedAtMs !== null) {
      return;
    }
    clear();
    toast.show(t("tasks.panel.restartDaemonCancelled"));
  }, [clear, toast, t]);

  return { restart, restartWithoutAsking: armNow, cancel, progress };
}

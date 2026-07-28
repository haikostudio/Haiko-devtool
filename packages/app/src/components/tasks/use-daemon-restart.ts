import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { useDaemonRestartStore } from "@/stores/daemon-restart-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  describeRestartProgress,
  type RestartProgress,
} from "@/components/tasks/daemon-restart-progress";

export interface DaemonRestartAction {
  /** Confirms, then restarts the daemon. */
  restart: () => Promise<void>;
  /** Restarts WITHOUT asking — for a restart the user already agreed to. */
  restartWithoutAsking: () => Promise<void>;
  /** What the bar should say right now (countdown, reconnecting, timed out). */
  progress: RestartProgress;
}

/**
 * Live restart state, derived from the shared store. Effect-free on purpose:
 * several surfaces read it at once, and only {@link DaemonRestartWatcher} is
 * allowed to drive the clock and settle the restart — otherwise every mounted
 * reader would fire its own timer and its own "moteur redémarré" toast.
 */
export function useDaemonRestartProgress(): RestartProgress {
  const startedAtMs = useDaemonRestartStore((state) => state.startedAtMs);
  const reconnected = useDaemonRestartStore((state) => state.reconnected);
  const nowMs = useDaemonRestartStore((state) => state.nowMs);
  return describeRestartProgress({ startedAtMs, nowMs, reconnected });
}

/**
 * The card's "Redémarrer le moteur" gesture.
 *
 * Restarting is never silent. A restart cuts every agent mid-turn, so the
 * confirmation says how many are working right now — the daemon is only ever
 * restarted on an explicit, informed go. `restartWithoutAsking` exists for the
 * one case where that go was already given: the user chose "publier puis
 * redémarrer", and asking twice for one decision is worse than not asking.
 */
export function useDaemonRestartAction(serverId: string | null): DaemonRestartAction {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId ?? "");
  const startedAtMs = useDaemonRestartStore((state) => state.startedAtMs);
  const begin = useDaemonRestartStore((state) => state.begin);
  const clear = useDaemonRestartStore((state) => state.clear);
  const progress = useDaemonRestartProgress();

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

  const fire = useCallback(async () => {
    if (!client || startedAtMs !== null) {
      return;
    }
    begin(Date.now());
    try {
      await client.restartServer("tasks_card_daemon_restart");
    } catch (error) {
      // The socket dropping mid-restart is the SUCCESS path, not a failure: the
      // daemon exits before it can answer, and the watcher settles the restart
      // when the connection comes back. Only a refusal that left us connected is
      // a real error — the watcher's timeout catches anything else.
      if (!useDaemonRestartStore.getState().sawDisconnect) {
        clear();
        toast.error(error instanceof Error ? error.message : String(error));
      }
    }
  }, [client, startedAtMs, begin, clear, toast]);

  const restart = useCallback(async () => {
    if (!client || startedAtMs !== null) {
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
    await fire();
  }, [client, startedAtMs, busyAgentCount, t, fire]);

  return { restart, restartWithoutAsking: fire, progress };
}

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { confirmDialog } from "@/utils/confirm-dialog";

export interface DaemonRestartAction {
  /** Confirms, then restarts the daemon. Resolves once the request is sent. */
  restart: () => Promise<void>;
  /** True from the moment the restart is sent until the daemon answers again. */
  restarting: boolean;
}

/**
 * The card's "Redémarrer le moteur" gesture: finishes a publication whose work
 * only takes effect after a daemon restart, without dropping to a terminal.
 *
 * Restarting is never silent. A restart cuts every agent mid-turn, so the
 * confirmation says how many are working right now — the repo rule is that the
 * daemon is only ever restarted on an explicit, informed go. The daemon comes
 * back on its own (its supervisor relaunches it) and the app reconnects, so the
 * "restarting" flag is only there to stop a second press landing in the gap.
 */
export function useDaemonRestartAction(serverId: string | null): DaemonRestartAction {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId ?? "");
  const [restarting, setRestarting] = useState(false);
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

  const restart = useCallback(async () => {
    if (!client || restarting) {
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
    setRestarting(true);
    try {
      await client.restartServer("tasks_card_daemon_restart");
      toast.show(t("tasks.panel.restartDaemonStarted"));
    } catch (error) {
      // The socket dropping mid-restart is the SUCCESS path, not a failure: the
      // daemon exits before it can answer. Only surface a real refusal.
      setRestarting(false);
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [client, restarting, busyAgentCount, t, toast]);

  return { restart, restarting };
}

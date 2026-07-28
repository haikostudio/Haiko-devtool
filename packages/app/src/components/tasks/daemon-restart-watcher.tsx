import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { KanbanTask } from "@/data/tasks";
import { useDaemonRestartStore } from "@/stores/daemon-restart-store";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import { isTaskDeployed } from "@/components/tasks/task-card-badge";
import { useDaemonRestartAction } from "@/components/tasks/use-daemon-restart";
import { RESTART_TIMEOUT_MS } from "@/components/tasks/daemon-restart-progress";

/** The countdown only needs to redraw once a second. */
const TICK_MS = 1000;

/**
 * Renders nothing; owns everything that must happen exactly once for a daemon
 * restart. Mounted a single time at the tasks screen root — putting these
 * effects in the shared hook would give every mounted reader its own timer and
 * its own "moteur redémarré" toast.
 *
 * Three jobs:
 *  - tick the clock the countdown reads, but only while a restart is in flight;
 *  - settle the restart when the connection drops and comes back (or give up,
 *    loudly, if it never does);
 *  - honour "publier puis redémarrer": fire the restart the user already agreed
 *    to, the moment that card's work is actually live.
 */
export function DaemonRestartWatcher({
  serverId,
  tasks,
}: {
  serverId: string | null;
  tasks: KanbanTask[];
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const connected = useHostRuntimeIsConnected(serverId ?? "");
  const startedAtMs = useDaemonRestartStore((state) => state.startedAtMs);
  const nowMs = useDaemonRestartStore((state) => state.nowMs);
  const sawDisconnect = useDaemonRestartStore((state) => state.sawDisconnect);
  const tick = useDaemonRestartStore((state) => state.tick);
  const markDisconnected = useDaemonRestartStore((state) => state.markDisconnected);
  const markReconnected = useDaemonRestartStore((state) => state.markReconnected);
  const clear = useDaemonRestartStore((state) => state.clear);
  const pendingTaskId = useDaemonRestartStore((state) => state.restartAfterDeployTaskId);
  const setRestartAfterDeploy = useDaemonRestartStore((state) => state.setRestartAfterDeploy);
  const { restartWithoutAsking } = useDaemonRestartAction(serverId);

  // Drive the countdown, and stop the moment it is over — an interval ticking on
  // an idle board is pure waste.
  useEffect(() => {
    if (startedAtMs === null) {
      return;
    }
    tick(Date.now());
    const timer = setInterval(() => tick(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [startedAtMs, tick]);

  // Down, then up again = the daemon is back.
  useEffect(() => {
    if (startedAtMs === null) {
      return;
    }
    if (!connected) {
      markDisconnected();
      return;
    }
    if (sawDisconnect) {
      markReconnected();
      clear();
      toast.show(t("tasks.panel.restartDaemonDone"));
    }
  }, [connected, startedAtMs, sawDisconnect, markDisconnected, markReconnected, clear, toast, t]);

  // A daemon that never came back: say so and free the bar, rather than
  // counting into the void.
  useEffect(() => {
    if (startedAtMs === null || nowMs - startedAtMs < RESTART_TIMEOUT_MS) {
      return;
    }
    clear();
    toast.error(t("tasks.panel.restartDaemonTimeout"));
  }, [nowMs, startedAtMs, clear, toast, t]);

  // "Publier puis redémarrer": wait for the card's work to actually be live,
  // then restart without asking again — the user already said yes, once, for
  // both steps. A card that turns out not to need a restart after all simply
  // drops the promise.
  useEffect(() => {
    if (pendingTaskId === null || startedAtMs !== null) {
      return;
    }
    const task = tasks.find((entry) => entry.id === pendingTaskId);
    if (!task) {
      // The card is gone (deleted, or another project is showing): drop it
      // rather than leave a restart armed forever.
      setRestartAfterDeploy(null);
      return;
    }
    if (!isTaskDeployed(task) && task.column !== "deployed") {
      return;
    }
    setRestartAfterDeploy(null);
    if (task.needsDaemonRestart !== true) {
      return;
    }
    toast.show(t("tasks.panel.restartAfterDeployFiring"));
    void restartWithoutAsking();
  }, [pendingTaskId, startedAtMs, tasks, setRestartAfterDeploy, restartWithoutAsking, toast, t]);

  return null;
}

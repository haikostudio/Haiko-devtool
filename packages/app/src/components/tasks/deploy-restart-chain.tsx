import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { KanbanTask } from "@/data/tasks";
import { useDaemonRestartStore } from "@/stores/daemon-restart-store";
import { useToast } from "@/contexts/toast-context";
import { isTaskDeployed } from "@/components/tasks/task-card-badge";
import { useDaemonRestartAction } from "@/components/tasks/use-daemon-restart";

/**
 * Renders nothing; honours "publier puis redémarrer". Lives on the tasks screen
 * (not the app root) because it is the only piece of the restart machinery that
 * needs the board: it waits for THAT card's work to actually be live, then fires
 * the restart the user already agreed to — without asking again, since it was
 * one decision.
 *
 * The restart still opens its normal undo window, so "one gesture" never means
 * "no way back".
 */
export function DeployRestartChain({
  serverId,
  tasks,
}: {
  serverId: string | null;
  tasks: KanbanTask[];
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const pendingTaskId = useDaemonRestartStore((state) => state.restartAfterDeployTaskId);
  const armedAtMs = useDaemonRestartStore((state) => state.armedAtMs);
  const startedAtMs = useDaemonRestartStore((state) => state.startedAtMs);
  const setRestartAfterDeploy = useDaemonRestartStore((state) => state.setRestartAfterDeploy);
  const { restartWithoutAsking } = useDaemonRestartAction(serverId);

  useEffect(() => {
    if (pendingTaskId === null || armedAtMs !== null || startedAtMs !== null) {
      return;
    }
    const task = tasks.find((entry) => entry.id === pendingTaskId);
    if (!task) {
      // The card is gone (deleted, or another project is showing): drop the
      // promise rather than leave a restart armed forever.
      setRestartAfterDeploy(null);
      return;
    }
    if (!isTaskDeployed(task) && task.column !== "deployed") {
      return;
    }
    setRestartAfterDeploy(null);
    // A card that turned out not to need a restart after all drops the promise
    // silently — the point was the restart, not the ceremony.
    if (task.needsDaemonRestart !== true) {
      return;
    }
    toast.show(t("tasks.panel.restartAfterDeployFiring"));
    restartWithoutAsking();
  }, [
    pendingTaskId,
    armedAtMs,
    startedAtMs,
    tasks,
    setRestartAfterDeploy,
    restartWithoutAsking,
    toast,
    t,
  ]);

  return null;
}

import { useDaemonRestartStore } from "@/stores/daemon-restart-store";
import { DaemonRestartWatcher } from "@/components/tasks/daemon-restart-watcher";

/**
 * Mounts the restart watcher at the app root, pointed at whichever host the
 * restart was fired on (recorded when arming).
 *
 * Root-level on purpose: a restart started from a task card must keep counting
 * down — and resume its interrupted agents — even if the user walks off to
 * another screen while waiting. Nothing at all is mounted when no restart is in
 * flight, so an idle app pays nothing for this.
 */
export function DaemonRestartHost() {
  const serverId = useDaemonRestartStore((state) => state.serverId);
  const armedAtMs = useDaemonRestartStore((state) => state.armedAtMs);
  const startedAtMs = useDaemonRestartStore((state) => state.startedAtMs);
  if (serverId === null || (armedAtMs === null && startedAtMs === null)) {
    return null;
  }
  return <DaemonRestartWatcher serverId={serverId} />;
}

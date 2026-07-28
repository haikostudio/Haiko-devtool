import type { DesktopDaemonStatus } from "@/desktop/daemon/desktop-daemon";

interface DesktopDaemonRestartStatus {
  desktopManaged: boolean;
  serverId: string;
}

interface DesktopDaemonRestartSettings {
  daemon: {
    manageBuiltInDaemon: boolean;
  };
}

export interface SettingsDaemonRestartDeps {
  getIsElectron: () => boolean;
  getDesktopDaemonStatus: () => Promise<DesktopDaemonRestartStatus>;
  getDesktopSettings: () => Promise<DesktopDaemonRestartSettings>;
  restartDesktopDaemon: () => Promise<DesktopDaemonStatus>;
  restartServer: (reason: string) => Promise<unknown>;
}

async function isLocalDesktopManagedDaemon(
  hostServerId: string,
  deps: SettingsDaemonRestartDeps,
): Promise<boolean> {
  if (!deps.getIsElectron()) {
    return false;
  }

  const desktopDaemonStatus = await deps.getDesktopDaemonStatus();
  if (!desktopDaemonStatus.desktopManaged) {
    return false;
  }

  const normalizedHostServerId = hostServerId.trim();
  const normalizedDesktopServerId = desktopDaemonStatus.serverId.trim();

  if (normalizedHostServerId.length === 0 || normalizedHostServerId !== normalizedDesktopServerId) {
    return false;
  }

  const desktopSettings = await deps.getDesktopSettings();
  return desktopSettings.daemon.manageBuiltInDaemon;
}

/**
 * Which mechanism actually restarted the daemon. The caller needs to know:
 * the desktop bridge restarts the process itself (so the page waits for the
 * reconnection on its own), while the RPC path goes through the shared restart
 * machinery, which already owns the countdown and the reconnection.
 */
export type SettingsDaemonRestartPath = "desktop" | "rpc";

export async function restartDaemonFromSettings(
  hostServerId: string,
  reason: string,
  deps: SettingsDaemonRestartDeps,
): Promise<SettingsDaemonRestartPath> {
  if (await isLocalDesktopManagedDaemon(hostServerId, deps)) {
    await deps.restartDesktopDaemon();
    return "desktop";
  }

  await deps.restartServer(reason);
  return "rpc";
}

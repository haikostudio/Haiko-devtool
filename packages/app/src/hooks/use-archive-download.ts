import { useCallback, useMemo } from "react";
import { useHosts } from "@/runtime/host-runtime";
import { useDownloadStore } from "@/stores/download-store";
import { useSessionStore } from "@/stores/session-store";

interface UseArchiveDownloadParams {
  serverId: string;
}

/**
 * Returns a stable callback that downloads a conductor-built archive by id. It
 * reuses the exact single-file download pipeline (host token → download-store →
 * web anchor / native download+share): the only difference is the token is
 * minted from an archive id instead of a workspace path.
 */
export function useArchiveDownload({
  serverId,
}: UseArchiveDownloadParams): (input: { archiveId: string; fileName: string }) => void {
  const daemons = useHosts();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const daemonProfile = useMemo(
    () => daemons.find((daemon) => daemon.serverId === serverId),
    [daemons, serverId],
  );
  const startDownload = useDownloadStore((state) => state.startDownload);

  return useCallback(
    ({ archiveId, fileName }) => {
      if (!client) {
        return;
      }
      void startDownload({
        serverId,
        scopeId: `archive:${archiveId}`,
        fileName,
        path: archiveId,
        daemonProfile,
        // startDownload only forwards `path` to this callback, so the archive id
        // rides through where a workspace path normally would.
        requestFileDownloadToken: async () => {
          const payload = await client.requestArchiveDownloadToken(archiveId);
          return {
            token: payload.token,
            fileName: payload.fileName,
            mimeType: payload.mimeType,
            error: payload.error,
          };
        },
      });
    },
    [client, daemonProfile, serverId, startDownload],
  );
}

import type { AttachmentLibraryEntry } from "@getpaseo/protocol/messages";
import { useTranslation } from "react-i18next";

import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

/**
 * Attachment library — a personal-fork feature listing every file/image that has
 * transited a workspace's agent chats, for the search drawer.
 *
 * Gated behind the `attachmentLibrary` daemon capability; callers must check
 * `serverInfo.features.attachmentLibrary === true` before mounting anything that
 * consumes this hook.
 */

const EMPTY: AttachmentLibraryEntry[] = [];
const STALE_MS = 10_000;

export function attachmentLibraryQueryKey(serverId: string, workspaceId: string) {
  return ["attachment-library", serverId, workspaceId] as const;
}

interface UseAttachmentLibraryOptions {
  serverId: string;
  workspaceId: string;
  /** When false the query stays disabled — pass the drawer's open state here. */
  enabled: boolean;
}

export function useAttachmentLibrary({
  serverId,
  workspaceId,
  enabled,
}: UseAttachmentLibraryOptions) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useFetchQuery<AttachmentLibraryEntry[]>({
    queryKey: attachmentLibraryQueryKey(serverId, workspaceId),
    dataShape: "value",
    staleTimeMs: STALE_MS,
    queryFn: async (): Promise<AttachmentLibraryEntry[]> => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      return await client.attachmentLibraryList(workspaceId);
    },
    enabled: enabled && !!client && isConnected && workspaceId.length > 0,
  });

  return {
    entries: query.data ?? EMPTY,
    isLoading: query.isLoading,
    error: query.error instanceof Error ? query.error.message : null,
    refetch: query.refetch,
  };
}

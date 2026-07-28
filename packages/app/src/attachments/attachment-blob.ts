import { Buffer } from "buffer";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type { AttachmentLibraryEntry } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { isWeb } from "@/constants/platform";

/** Bytes of one library entry, as served by the daemon over the WebSocket. */
export interface AttachmentBlob {
  base64: string;
  mimeType: string;
  /** Ready-to-render `data:` URL — what image views and blob builders consume. */
  dataUrl: string;
}

// Blobs are immutable once indexed, so a long stale time avoids refetching a
// thumbnail or a preview we already have.
const BLOB_STALE_MS = 60 * 60 * 1000;

export function attachmentBlobQueryKey(serverId: string, workspaceId: string, entryId: string) {
  return ["attachment-blob", serverId, workspaceId, entryId] as const;
}

/**
 * Fetch a library entry's bytes once and cache them. Shared by the list (image
 * thumbnails) and the preview pane, so opening a picture that was already
 * thumbnailed costs nothing.
 */
export function useAttachmentBlob(input: {
  serverId: string;
  workspaceId: string;
  entry: AttachmentLibraryEntry;
  enabled: boolean;
}) {
  const { serverId, workspaceId, entry, enabled } = input;
  const client = useHostRuntimeClient(serverId);
  return useFetchQuery<AttachmentBlob | null>({
    queryKey: attachmentBlobQueryKey(serverId, workspaceId, entry.id),
    dataShape: "value",
    staleTimeMs: BLOB_STALE_MS,
    enabled: enabled && !!client && entry.hasPreview !== false,
    queryFn: async (): Promise<AttachmentBlob | null> => {
      if (!client) {
        return null;
      }
      const payload = await client.attachmentLibraryBlob(workspaceId, entry.id);
      if (!payload.dataBase64) {
        if (payload.error) {
          throw new Error(payload.error);
        }
        return null;
      }
      const mimeType = payload.mimeType ?? entry.mimeType;
      return {
        base64: payload.dataBase64,
        mimeType,
        dataUrl: `data:${mimeType};base64,${payload.dataBase64}`,
      };
    },
  });
}

/** Decode base64 bytes as UTF-8 text — for the markdown and SVG previews. */
export function decodeAttachmentText(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}

/** Save/open an entry's bytes — data-URL download on web, share sheet on native. */
export async function openAttachment(
  client: DaemonClient,
  workspaceId: string,
  entry: AttachmentLibraryEntry,
): Promise<void> {
  const payload = await client.attachmentLibraryBlob(workspaceId, entry.id);
  if (!payload.dataBase64) {
    throw new Error(payload.error ?? "Fichier indisponible.");
  }
  const mimeType = payload.mimeType ?? entry.mimeType;
  if (isWeb) {
    if (typeof document === "undefined") {
      return;
    }
    const link = document.createElement("a");
    link.href = `data:${mimeType};base64,${payload.dataBase64}`;
    link.download = entry.fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }
  const targetUri = `${LegacyFileSystem.cacheDirectory ?? ""}${entry.id}-${entry.fileName}`;
  await LegacyFileSystem.writeAsStringAsync(targetUri, payload.dataBase64, {
    encoding: LegacyFileSystem.EncodingType.Base64,
  });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(targetUri, { mimeType });
  }
}

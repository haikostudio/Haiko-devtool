import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceUiState } from "@getpaseo/protocol/messages";
import type { AttachmentMetadata, UserComposerAttachment } from "@/attachments/types";
import { getAttachmentStore } from "@/attachments/store";
import { persistAttachmentFromDataUrl } from "@/attachments/service";
import { useDraftStore } from "@/stores/draft-store";

// Bytes are uploaded / materialized at most once per id per app session. The
// daemon holds the durable copy; these sets just avoid redundant round-trips.
const uploadedIds = new Set<string>();
const materializedIds = new Set<string>();

function collectImageAttachments(state: WorkspaceUiState): AttachmentMetadata[] {
  const out: AttachmentMetadata[] = [];
  for (const draft of Object.values(state.drafts)) {
    for (const raw of draft.input.attachments) {
      const attachment = raw as unknown as UserComposerAttachment;
      if (attachment.kind === "image") {
        out.push(attachment.metadata);
      }
    }
  }
  return out;
}

// Swap an image attachment's metadata across every draft that references it,
// preserving the record's version/updatedAt so re-materializing on a device does
// not bump the draft or (with the storageKey-agnostic canonical) trigger a push.
function patchDraftImageMetadata(nextMeta: AttachmentMetadata): void {
  useDraftStore.setState((prev) => {
    let changed = false;
    const drafts: typeof prev.drafts = { ...prev.drafts };
    for (const [key, record] of Object.entries(prev.drafts)) {
      let attachmentsChanged = false;
      const attachments = record.input.attachments.map((attachment) => {
        if (attachment.kind === "image" && attachment.metadata.id === nextMeta.id) {
          attachmentsChanged = true;
          return { kind: "image", metadata: nextMeta } satisfies UserComposerAttachment;
        }
        return attachment;
      });
      if (attachmentsChanged) {
        changed = true;
        drafts[key] = { ...record, input: { ...record.input, attachments } };
      }
    }
    return changed ? { drafts } : prev;
  });
}

/**
 * Best-effort: uploads the bytes of any draft image in this workspace state to
 * the daemon so other devices can materialize it. Local metadata resolves fine
 * on the source device, so encodeBase64 succeeds here.
 */
export async function uploadDraftImageBytes(
  client: DaemonClient,
  state: WorkspaceUiState,
): Promise<void> {
  const images = collectImageAttachments(state).filter((meta) => !uploadedIds.has(meta.id));
  if (images.length === 0) {
    return;
  }
  const store = await getAttachmentStore();
  for (const meta of images) {
    try {
      const dataBase64 = await store.encodeBase64({ attachment: meta });
      await client.putDraftAttachment({
        id: meta.id,
        mimeType: meta.mimeType,
        fileName: meta.fileName ?? null,
        dataBase64,
      });
      uploadedIds.add(meta.id);
    } catch {
      // Leave the id unmarked so a later push retries the upload.
    }
  }
}

/**
 * Best-effort: for every draft image in this remote state whose bytes are not
 * yet local, downloads them from the daemon, persists them locally UNDER THE
 * SAME id, and rewrites the draft's attachment metadata to the local copy so the
 * composer can preview/encode it. Ids that the daemon doesn't have yet are left
 * unmarked so a later broadcast retries.
 */
export async function materializeDraftImageBytes(
  client: DaemonClient,
  state: WorkspaceUiState,
): Promise<void> {
  const images = collectImageAttachments(state).filter((meta) => !materializedIds.has(meta.id));
  if (images.length === 0) {
    return;
  }
  for (const meta of images) {
    try {
      const remote = await client.getDraftAttachment(meta.id);
      if (!remote) {
        continue;
      }
      const localMeta = await persistAttachmentFromDataUrl({
        id: meta.id,
        mimeType: remote.mimeType,
        fileName: remote.fileName,
        dataUrl: `data:${remote.mimeType};base64,${remote.dataBase64}`,
      });
      materializedIds.add(meta.id);
      patchDraftImageMetadata(localMeta);
    } catch {
      // Leave the id unmarked so a later broadcast retries materialization.
    }
  }
}

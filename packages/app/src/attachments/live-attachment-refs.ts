// Tracks the attachment ids that live composer instances currently hold in their
// in-memory input state, keyed by draftKey. The draft-store attachment garbage
// collector consults this so a blob a composer is still visibly displaying is
// never collected — even when the persisted draft record momentarily disagrees
// (e.g. a cross-device sent/abandoned tombstone lands with empty attachments
// while the focused composer keeps the image the user just pasted). Without this
// root, the GC would delete the blob and the preview would blank out and the
// image would drop from the sent message.
const liveAttachmentIdsByDraftKey = new Map<string, Set<string>>();

export function setLiveComposerAttachmentIds(draftKey: string, ids: Set<string>): void {
  if (ids.size === 0) {
    liveAttachmentIdsByDraftKey.delete(draftKey);
    return;
  }
  liveAttachmentIdsByDraftKey.set(draftKey, ids);
}

export function clearLiveComposerAttachmentIds(draftKey: string): void {
  liveAttachmentIdsByDraftKey.delete(draftKey);
}

export function collectLiveComposerAttachmentIds(into: Set<string>): void {
  for (const ids of liveAttachmentIdsByDraftKey.values()) {
    for (const id of ids) {
      into.add(id);
    }
  }
}

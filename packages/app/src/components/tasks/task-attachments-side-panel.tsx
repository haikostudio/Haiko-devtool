import { useCallback, useMemo, useState } from "react";
import type { AttachmentLibraryEntry } from "@getpaseo/protocol/messages";

import {
  AttachmentLibraryList,
  type AttachmentSortKey,
} from "@/attachments/attachment-library-list";
import { AttachmentPreview } from "@/attachments/attachment-preview";
import { useAttachmentLibrary } from "@/attachments/use-attachment-library";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { TaskSlideOverPanel } from "./task-slide-over-panel";

export interface TaskAttachmentsSidePanelProps {
  serverId: string | null;
  workspaceId: string | null;
}

/**
 * The project's attachments as a slide-over: the paperclip opens the list of
 * every file that transited the project's chats, and picking one swaps the same
 * panel to its preview with a back arrow to the list.
 *
 * Chrome comes from the shared `TaskSlideOverPanel` — same width, animation and
 * Esc handling as the board's file preview.
 */
export function TaskAttachmentsSidePanel({ serverId, workspaceId }: TaskAttachmentsSidePanelProps) {
  if (!serverId || !workspaceId) {
    return null;
  }
  // Keyed by workspace: switching projects starts the panel over rather than
  // showing the previous project's search and selection.
  return <AttachmentsPanel key={workspaceId} serverId={serverId} workspaceId={workspaceId} />;
}

function AttachmentsPanel({ serverId, workspaceId }: { serverId: string; workspaceId: string }) {
  const open = useTasksBoardUiStore((state) => state.attachmentsOpen);
  const setOpen = useTasksBoardUiStore((state) => state.setAttachmentsOpen);
  const entryId = useTasksBoardUiStore((state) => state.attachmentsEntryId);
  const setEntryId = useTasksBoardUiStore((state) => state.setAttachmentsEntryId);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<AttachmentSortKey>("recent");

  const { entries, isLoading, error } = useAttachmentLibrary({
    serverId,
    workspaceId,
    enabled: open,
  });
  // Same dragged width as the file preview: the board has one slide-over size,
  // so switching between a file and its attachments never jumps.
  const requestedWidth = useTasksBoardUiStore((state) => state.previewWidth);
  const onRequestWidth = useTasksBoardUiStore((state) => state.setPreviewWidth);
  const resize = useMemo(
    () => ({ requestedWidth, onRequestWidth }),
    [onRequestWidth, requestedWidth],
  );

  const selected = useMemo(
    () => (entryId ? (entries.find((entry) => entry.id === entryId) ?? null) : null),
    [entries, entryId],
  );

  const handleClose = useCallback(() => setOpen(false), [setOpen]);
  const handleBack = useCallback(() => setEntryId(null), [setEntryId]);
  const handleSelect = useCallback(
    (entry: AttachmentLibraryEntry) => setEntryId(entry.id),
    [setEntryId],
  );
  const handleSearch = useCallback((value: string) => setQuery(value.trim().toLowerCase()), []);

  const header = useMemo(
    () =>
      selected
        ? {
            title: selected.fileName,
            back: { onPress: handleBack, accessibilityLabel: "Revenir à la liste" },
          }
        : {
            title: "Pièces jointes",
            search: {
              onChange: handleSearch,
              placeholder: "Rechercher par nom ou type…",
              autoFocus: false,
              testID: "attachment-library-search",
            },
          },
    [handleBack, handleSearch, selected],
  );

  return (
    <TaskSlideOverPanel
      open={open}
      onClose={handleClose}
      header={header}
      resize={resize}
      testID="tasks-attachments-panel"
      sheetTestID="tasks-attachments-sheet"
      closeTestID="tasks-attachments-close"
      closeAccessibilityLabel="Fermer les pièces jointes"
    >
      {selected ? (
        <AttachmentPreview serverId={serverId} workspaceId={workspaceId} entry={selected} />
      ) : (
        <AttachmentLibraryList
          serverId={serverId}
          workspaceId={workspaceId}
          entries={entries}
          query={query}
          sort={sort}
          onSortChange={setSort}
          onSelect={handleSelect}
          isLoading={isLoading}
          error={error}
        />
      )}
    </TaskSlideOverPanel>
  );
}

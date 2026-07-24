import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { Paperclip } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProjectAttachment } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { MaterialFileIcon } from "@/components/material-file-icon";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { formatTimeAgo } from "@/utils/time";
import type { Theme } from "@/styles/theme";

const ThemedPaperclip = withUnistyles(Paperclip);

const EMPTY_TOOLTIP_KEYS: never[] = [];

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface ProjectAttachmentsButtonProps {
  serverId: string;
  projectId: string;
}

export function ProjectAttachmentsButton({
  serverId,
  projectId,
}: ProjectAttachmentsButtonProps): ReactElement {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  const accessibilityState = useMemo(() => ({ expanded: isOpen }), [isOpen]);

  return (
    <>
      <HeaderToggleButton
        testID="project-attachments-button"
        onPress={open}
        tooltipLabel="Attachments"
        tooltipKeys={EMPTY_TOOLTIP_KEYS}
        tooltipSide="left"
        accessibilityRole="button"
        accessibilityLabel="Open project attachments"
        accessibilityState={accessibilityState}
      >
        {({ hovered, pressed }) => (
          <ThemedPaperclip
            size={16}
            uniProps={hovered || pressed ? foregroundColorMapping : mutedColorMapping}
          />
        )}
      </HeaderToggleButton>
      {isOpen ? (
        <ProjectAttachmentsSheet
          serverId={serverId}
          projectId={projectId}
          visible={isOpen}
          onClose={close}
        />
      ) : null}
    </>
  );
}

interface ProjectAttachmentsSheetProps {
  serverId: string;
  projectId: string;
  visible: boolean;
  onClose: () => void;
}

function ProjectAttachmentsSheet({
  serverId,
  projectId,
  visible,
  onClose,
}: ProjectAttachmentsSheetProps): ReactElement {
  const client = useHostRuntimeClient(serverId);
  const [query, setQuery] = useState("");

  const attachmentsQuery = useFetchQuery({
    queryKey: ["project-attachments", serverId, projectId],
    queryFn: () => (client ? client.listProjectAttachments(projectId) : []),
    enabled: visible && Boolean(client),
    dataShape: "list",
    staleTimeMs: 5_000,
  });

  const attachments = useMemo(() => attachmentsQuery.data ?? [], [attachmentsQuery.data]);
  const filtered = useMemo(() => filterAttachments(attachments, query), [attachments, query]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: "Attachments",
      search: {
        onChange: setQuery,
        placeholder: "Search by name or type",
        testID: "project-attachments-search",
      },
    }),
    [],
  );

  return (
    <AdaptiveModalSheet header={header} visible={visible} onClose={onClose}>
      <View style={styles.body}>
        <ProjectAttachmentsContent
          isLoading={attachmentsQuery.isLoading}
          totalCount={attachments.length}
          attachments={filtered}
        />
      </View>
    </AdaptiveModalSheet>
  );
}

interface ProjectAttachmentsContentProps {
  isLoading: boolean;
  totalCount: number;
  attachments: ProjectAttachment[];
}

function ProjectAttachmentsContent({
  isLoading,
  totalCount,
  attachments,
}: ProjectAttachmentsContentProps): ReactElement {
  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }
  if (attachments.length === 0) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>
          {totalCount === 0
            ? "No files have been shared in this project yet."
            : "No files match your search."}
        </Text>
      </View>
    );
  }
  return (
    <>
      {attachments.map((attachment) => (
        <AttachmentRow key={attachment.id} attachment={attachment} />
      ))}
    </>
  );
}

function AttachmentRow({ attachment }: { attachment: ProjectAttachment }): ReactElement {
  const addedAt = new Date(attachment.addedAt);
  const dateLabel = Number.isNaN(addedAt.getTime()) ? "" : formatTimeAgo(addedAt);
  const meta = [formatFileSize(attachment.size), dateLabel].filter(Boolean).join(" · ");

  return (
    <View style={styles.row}>
      <MaterialFileIcon fileName={attachment.fileName} size={20} />
      <View style={styles.rowText}>
        <Text style={styles.rowLabel} numberOfLines={1}>
          {attachment.fileName}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
    </View>
  );
}

function filterAttachments(attachments: ProjectAttachment[], query: string): ProjectAttachment[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) {
    return attachments;
  }
  return attachments.filter((attachment) => {
    const extension = fileExtension(attachment.fileName);
    return (
      attachment.fileName.toLowerCase().includes(trimmed) ||
      attachment.mimeType.toLowerCase().includes(trimmed) ||
      extension.includes(trimmed)
    );
  });
}

function fileExtension(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index === -1 ? "" : fileName.slice(index + 1).toLowerCase();
}

function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create((theme) => ({
  body: {
    paddingBottom: theme.spacing[4],
  },
  centered: {
    paddingVertical: theme.spacing[8],
    alignItems: "center",
    justifyContent: "center",
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    paddingHorizontal: theme.spacing[6],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[6],
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  rowLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  rowMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));

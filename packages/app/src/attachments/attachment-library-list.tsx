import { useCallback, useMemo } from "react";
import { Image as RNImage, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { SvgXml } from "react-native-svg";
import type { AttachmentLibraryEntry } from "@getpaseo/protocol/messages";

import { getFileIconSvg } from "@/components/material-file-icons";
import { useAttachmentBlob } from "@/attachments/attachment-blob";
import { formatFileSize } from "@/utils/format-file-size";

export type AttachmentSortKey = "recent" | "size" | "name";

const SORT_LABELS: Record<AttachmentSortKey, string> = {
  recent: "Récents",
  size: "Poids",
  name: "Nom",
};

const SORT_KEYS = Object.keys(SORT_LABELS) as AttachmentSortKey[];

const dateFormatter = new Intl.DateTimeFormat("fr-CH", {
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function formatAddedAt(addedAt: number): string {
  if (!Number.isFinite(addedAt) || addedAt <= 0) {
    return "";
  }
  return dateFormatter.format(new Date(addedAt));
}

/** Case-insensitive match of a query against name, type and kind. */
export function matchesAttachmentQuery(entry: AttachmentLibraryEntry, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  const haystack = `${entry.fileName} ${entry.mimeType} ${entry.kind}`.toLowerCase();
  return haystack.includes(query);
}

function sortEntries(
  entries: AttachmentLibraryEntry[],
  sort: AttachmentSortKey,
): AttachmentLibraryEntry[] {
  const copy = [...entries];
  copy.sort((a, b) => {
    if (sort === "size") return b.size - a.size;
    if (sort === "name") return a.fileName.localeCompare(b.fileName);
    return b.addedAt - a.addedAt;
  });
  return copy;
}

interface AttachmentGroup {
  key: string;
  title: string;
  entries: AttachmentLibraryEntry[];
}

/** Group by originating agent, each group sorted, groups ordered by recency. */
function groupByAgent(
  entries: AttachmentLibraryEntry[],
  sort: AttachmentSortKey,
): AttachmentGroup[] {
  const groups = new Map<string, AttachmentGroup>();
  for (const entry of entries) {
    const key = entry.agentId ?? "sans-agent";
    const title = entry.agentTitle?.trim() || "Sans titre";
    const group = groups.get(key) ?? { key, title, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.entries = sortEntries(group.entries, sort);
  }
  list.sort((a, b) => {
    const aRecent = a.entries[0]?.addedAt ?? 0;
    const bRecent = b.entries[0]?.addedAt ?? 0;
    return bRecent - aRecent;
  });
  return list;
}

/** Leading slot: a live image thumbnail for images, else the file-type icon. */
function AttachmentLeading({
  serverId,
  workspaceId,
  entry,
}: {
  serverId: string;
  workspaceId: string;
  entry: AttachmentLibraryEntry;
}) {
  const isImage = entry.kind === "image";
  const { data: blob } = useAttachmentBlob({ serverId, workspaceId, entry, enabled: isImage });
  const imageSource = useMemo(() => (blob ? { uri: blob.dataUrl } : null), [blob]);
  if (isImage && imageSource) {
    return <RNImage source={imageSource} style={styles.thumb} resizeMode="cover" />;
  }
  return (
    <View style={styles.iconSlot}>
      <SvgXml xml={getFileIconSvg(entry.fileName)} width={22} height={22} />
    </View>
  );
}

/** One tappable row — leading preview/icon, name, then size · date. */
function AttachmentRow({
  serverId,
  workspaceId,
  entry,
  onSelect,
}: {
  serverId: string;
  workspaceId: string;
  entry: AttachmentLibraryEntry;
  onSelect: (entry: AttachmentLibraryEntry) => void;
}) {
  const handlePress = useCallback(() => onSelect(entry), [entry, onSelect]);
  const addedAt = formatAddedAt(entry.addedAt);
  const meta = [formatFileSize(entry.size), addedAt].filter(Boolean).join(" · ");

  return (
    <Pressable
      style={styles.row}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Aperçu de ${entry.fileName}`}
      testID={`attachment-library-row-${entry.id}`}
    >
      <AttachmentLeading serverId={serverId} workspaceId={workspaceId} entry={entry} />
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {entry.fileName}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {meta}
        </Text>
      </View>
    </Pressable>
  );
}

/** One sort chip — its own component so the press handler stays stable. */
function SortChip({
  sortKey,
  active,
  onChange,
}: {
  sortKey: AttachmentSortKey;
  active: boolean;
  onChange: (sort: AttachmentSortKey) => void;
}) {
  const handlePress = useCallback(() => onChange(sortKey), [onChange, sortKey]);
  return (
    <Pressable
      style={active ? styles.sortChipActive : styles.sortChip}
      onPress={handlePress}
      accessibilityRole="button"
      testID={`attachment-library-sort-${sortKey}`}
    >
      <Text style={active ? styles.sortChipTextActive : styles.sortChipText}>
        {SORT_LABELS[sortKey]}
      </Text>
    </Pressable>
  );
}

/** Segmented sort control (Récents / Poids / Nom). */
function SortControl({
  sort,
  onChange,
}: {
  sort: AttachmentSortKey;
  onChange: (sort: AttachmentSortKey) => void;
}) {
  return (
    <View style={styles.sortRow}>
      {SORT_KEYS.map((key) => (
        <SortChip key={key} sortKey={key} active={key === sort} onChange={onChange} />
      ))}
    </View>
  );
}

export interface AttachmentLibraryListProps {
  serverId: string;
  workspaceId: string;
  entries: AttachmentLibraryEntry[];
  /** Already lowercased and trimmed by the caller's search field. */
  query: string;
  sort: AttachmentSortKey;
  onSortChange: (sort: AttachmentSortKey) => void;
  onSelect: (entry: AttachmentLibraryEntry) => void;
  isLoading: boolean;
  error: string | null;
}

/**
 * Every file/image that transited the project's chats, grouped by the agent that
 * carried it. Tapping a row hands the entry back to the panel, which swaps to
 * its preview.
 */
export function AttachmentLibraryList({
  serverId,
  workspaceId,
  entries,
  query,
  sort,
  onSortChange,
  onSelect,
  isLoading,
  error,
}: AttachmentLibraryListProps) {
  const groups = useMemo(() => {
    const filtered = entries.filter((entry) => matchesAttachmentQuery(entry, query));
    return groupByAgent(filtered, sort);
  }, [entries, query, sort]);

  const total = useMemo(
    () => groups.reduce((sum, group) => sum + group.entries.length, 0),
    [groups],
  );

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.body}>
      <SortControl sort={sort} onChange={onSortChange} />
      {isLoading && entries.length === 0 ? <Text style={styles.hint}>Chargement…</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {!isLoading && total === 0 ? (
        <Text style={styles.hint}>
          {entries.length === 0
            ? "Aucun fichier n'a encore transité dans ce projet."
            : "Aucun fichier ne correspond à la recherche."}
        </Text>
      ) : null}
      {groups.map((group) => (
        <View key={group.key} style={styles.group}>
          <Text style={styles.groupTitle}>{group.title}</Text>
          <View style={styles.list}>
            {group.entries.map((entry) => (
              <AttachmentRow
                key={entry.id}
                serverId={serverId}
                workspaceId={workspaceId}
                entry={entry}
                onSelect={onSelect}
              />
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  body: {
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    paddingBottom: theme.spacing[6],
  },
  sortRow: {
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  sortChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  // Self-contained (not merged with sortChip) so chips pass a single style object
  // — inline style arrays trip the react-perf lint.
  sortChipActive: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  sortChipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  sortChipTextActive: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.primaryForeground,
    fontWeight: "700",
  },
  group: {
    gap: theme.spacing[2],
  },
  groupTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  list: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  thumb: {
    width: 34,
    height: 34,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  iconSlot: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  rowText: {
    flex: 1,
    gap: theme.spacing[1],
  },
  rowName: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  rowMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  error: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[500],
  },
}));

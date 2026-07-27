import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Image as RNImage, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Paperclip } from "lucide-react-native";
import { SvgXml } from "react-native-svg";
import * as LegacyFileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import type { AttachmentLibraryEntry } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { getFileIconSvg } from "@/components/material-file-icons";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useAttachmentLibrary } from "@/attachments/use-attachment-library";
import { formatFileSize } from "@/utils/format-file-size";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

const ThemedPaperclip = withUnistyles(Paperclip);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type SortKey = "recent" | "size" | "name";

const SORT_LABELS: Record<SortKey, string> = {
  recent: "Récents",
  size: "Poids",
  name: "Nom",
};

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

/** Case/diacritic-insensitive match of a query against name, type and kind. */
function matchesQuery(entry: AttachmentLibraryEntry, query: string): boolean {
  if (query.length === 0) {
    return true;
  }
  const haystack = `${entry.fileName} ${entry.mimeType} ${entry.kind}`.toLowerCase();
  return haystack.includes(query);
}

function sortEntries(entries: AttachmentLibraryEntry[], sort: SortKey): AttachmentLibraryEntry[] {
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
function groupByAgent(entries: AttachmentLibraryEntry[], sort: SortKey): AttachmentGroup[] {
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

// Blobs are immutable once indexed, so a long stale time avoids refetching a
// thumbnail we already have.
const BLOB_STALE_MS = 60 * 60 * 1000;

/** Fetch a library entry's bytes once and cache them (base64 over the WS). */
function useAttachmentBlob(
  serverId: string,
  workspaceId: string,
  entry: AttachmentLibraryEntry,
  enabled: boolean,
) {
  const client = useHostRuntimeClient(serverId);
  return useFetchQuery<string | null>({
    queryKey: ["attachment-blob", serverId, workspaceId, entry.id],
    dataShape: "value",
    staleTimeMs: BLOB_STALE_MS,
    enabled: enabled && !!client && entry.hasPreview !== false,
    queryFn: async (): Promise<string | null> => {
      if (!client) {
        return null;
      }
      const payload = await client.attachmentLibraryBlob(workspaceId, entry.id);
      if (!payload.dataBase64) {
        return null;
      }
      return `data:${payload.mimeType ?? entry.mimeType};base64,${payload.dataBase64}`;
    },
  });
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
  const { data: dataUrl } = useAttachmentBlob(serverId, workspaceId, entry, isImage);
  const imageSource = useMemo(() => (dataUrl ? { uri: dataUrl } : null), [dataUrl]);
  if (isImage && imageSource) {
    return <RNImage source={imageSource} style={styles.thumb} resizeMode="cover" />;
  }
  return (
    <View style={styles.iconSlot}>
      <SvgXml xml={getFileIconSvg(entry.fileName)} width={22} height={22} />
    </View>
  );
}

/** Save/open a library entry's bytes — data-URL download on web, share on native. */
async function openAttachment(
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

/** One tappable row — leading preview/icon, name, then size · date. */
function AttachmentRow({
  serverId,
  workspaceId,
  entry,
}: {
  serverId: string;
  workspaceId: string;
  entry: AttachmentLibraryEntry;
}) {
  const client = useHostRuntimeClient(serverId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handlePress = useCallback(async () => {
    if (!client || busy) return;
    setBusy(true);
    setError(null);
    try {
      await openAttachment(client, workspaceId, entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Échec de l'ouverture.");
    } finally {
      setBusy(false);
    }
  }, [client, busy, workspaceId, entry]);

  const addedAt = formatAddedAt(entry.addedAt);
  const meta = [formatFileSize(entry.size), addedAt].filter(Boolean).join(" · ");

  return (
    <Pressable
      style={styles.row}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`Ouvrir ${entry.fileName}`}
      testID={`attachment-library-row-${entry.id}`}
    >
      <AttachmentLeading serverId={serverId} workspaceId={workspaceId} entry={entry} />
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {entry.fileName}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {error ?? meta}
        </Text>
      </View>
      {busy ? <ThemedActivityIndicator size="small" uniProps={iconColorMapping} /> : null}
    </Pressable>
  );
}

const SORT_KEYS = Object.keys(SORT_LABELS) as SortKey[];

/** One sort chip — its own component so the press handler stays stable. */
function SortChip({
  sortKey,
  active,
  onChange,
}: {
  sortKey: SortKey;
  active: boolean;
  onChange: (sort: SortKey) => void;
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
function SortControl({ sort, onChange }: { sort: SortKey; onChange: (sort: SortKey) => void }) {
  return (
    <View style={styles.sortRow}>
      {SORT_KEYS.map((key) => (
        <SortChip key={key} sortKey={key} active={key === sort} onChange={onChange} />
      ))}
    </View>
  );
}

function AttachmentLibraryModalBody({
  serverId,
  workspaceId,
  query,
  sort,
  onSortChange,
}: {
  serverId: string;
  workspaceId: string;
  query: string;
  sort: SortKey;
  onSortChange: (sort: SortKey) => void;
}) {
  const { entries, isLoading, error } = useAttachmentLibrary({
    serverId,
    workspaceId,
    enabled: true,
  });

  const groups = useMemo(() => {
    const filtered = entries.filter((entry) => matchesQuery(entry, query));
    return groupByAgent(filtered, sort);
  }, [entries, query, sort]);

  const total = useMemo(
    () => groups.reduce((sum, group) => sum + group.entries.length, 0),
    [groups],
  );

  return (
    <View style={styles.body}>
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
              />
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

interface AttachmentLibraryButtonProps {
  serverId: string;
  workspaceId: string;
  /** Compact icon-only rendering for the mobile header row. */
  compact?: boolean;
}

/**
 * "Pièces jointes" — opens a drawer listing every file/image that transited the
 * project's chats, with search, grouping by agent, sort, image previews and
 * download. Gated by the caller on the `attachmentLibrary` daemon capability.
 */
export function AttachmentLibraryButton({
  serverId,
  workspaceId,
  compact = false,
}: AttachmentLibraryButtonProps) {
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);
  const iconSize = compact ? 20 : 16;

  return (
    <>
      <Pressable
        testID="attachment-library-button"
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel="Pièces jointes du projet"
        style={compact ? styles.buttonCompact : styles.button}
      >
        <ThemedPaperclip size={iconSize} uniProps={iconColorMapping} />
      </Pressable>
      <AttachmentLibrarySheet
        serverId={serverId}
        workspaceId={workspaceId}
        visible={open}
        onClose={handleClose}
      />
    </>
  );
}

/**
 * The library drawer without its icon trigger, for headers that gather their
 * project actions behind a single overflow menu (the mobile task board) and
 * therefore own the open/closed state themselves.
 */
export function AttachmentLibrarySheet({
  serverId,
  workspaceId,
  visible,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");

  const handleClose = useCallback(() => {
    setQuery("");
    onClose();
  }, [onClose]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: "Pièces jointes",
      search: {
        onChange: (value: string) => setQuery(value.trim().toLowerCase()),
        placeholder: "Rechercher par nom ou type…",
        autoFocus: false,
      },
    }),
    [],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={handleClose}
      header={header}
      testID="attachment-library-modal"
    >
      <AttachmentLibraryModalBody
        serverId={serverId}
        workspaceId={workspaceId}
        query={query}
        sort={sort}
        onSortChange={setSort}
      />
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  buttonCompact: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
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

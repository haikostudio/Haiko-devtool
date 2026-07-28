import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Download } from "lucide-react-native";
import type { AttachmentLibraryEntry } from "@getpaseo/protocol/messages";

import { openAttachment } from "@/attachments/attachment-blob";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { alertDialog } from "@/utils/confirm-dialog";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const ThemedDownload = withUnistyles(Download);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Web saves the file, native hands it to the share sheet. */
export const DOWNLOAD_LABEL = isWeb ? "Télécharger" : "Ouvrir";

export interface AttachmentDownloadTarget {
  serverId: string;
  workspaceId: string;
  entry: AttachmentLibraryEntry;
}

/**
 * Runs a save/open of one library entry, tracking its in-flight and failed
 * states so callers can render either an inline card or a header icon.
 */
export function useAttachmentDownload({ serverId, workspaceId, entry }: AttachmentDownloadTarget) {
  const client = useHostRuntimeClient(serverId);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  /** Resolves with the error message, or `null` when the file went through. */
  const run = useCallback(async (): Promise<string | null> => {
    if (!client || busy) {
      return null;
    }
    setBusy(true);
    setFailure(null);
    try {
      await openAttachment(client, workspaceId, entry);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Échec de l'ouverture.";
      setFailure(message);
      return message;
    } finally {
      setBusy(false);
    }
  }, [busy, client, entry, workspaceId]);

  return { run, busy, failure };
}

/**
 * Icon-only download, for the attachments panel header: every preview keeps the
 * "get the actual file" escape hatch the list used to offer on tap, whatever the
 * file type.
 */
export function AttachmentDownloadAction(target: AttachmentDownloadTarget) {
  const { run, busy } = useAttachmentDownload(target);
  const handlePress = useCallback(async () => {
    // The header has no room for an error line, and native alerts are banned —
    // so a failure goes to the app dialog. The message comes from `run` itself:
    // the state it also sets is not readable in this same tick.
    const failure = await run();
    if (failure) {
      await alertDialog(DOWNLOAD_LABEL, failure);
    }
  }, [run]);

  return (
    <Pressable
      onPress={handlePress}
      style={styles.iconButton}
      accessibilityRole="button"
      accessibilityLabel={`${DOWNLOAD_LABEL} ${target.entry.fileName}`}
      testID="attachment-preview-download"
      hitSlop={8}
    >
      {busy ? (
        <ThemedActivityIndicator size="small" uniProps={mutedColorMapping} />
      ) : (
        <ThemedDownload size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      )}
    </Pressable>
  );
}

/** Labelled variant, for the "aperçu indisponible" card. */
export function AttachmentDownloadButton(target: AttachmentDownloadTarget) {
  const { run, busy, failure } = useAttachmentDownload(target);
  const handlePress = useCallback(() => void run(), [run]);

  return (
    <View style={styles.column}>
      <Pressable
        onPress={handlePress}
        style={styles.button}
        accessibilityRole="button"
        accessibilityLabel={`${DOWNLOAD_LABEL} ${target.entry.fileName}`}
        testID="attachment-preview-download-button"
      >
        {busy ? (
          <ThemedActivityIndicator size="small" uniProps={mutedColorMapping} />
        ) : (
          <ThemedDownload size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        )}
        <Text style={styles.label}>{DOWNLOAD_LABEL}</Text>
      </Pressable>
      {failure ? <Text style={styles.error}>{failure}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: {
    alignItems: "center",
    gap: theme.spacing[2],
  },
  iconButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
}));

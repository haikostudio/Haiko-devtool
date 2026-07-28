import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, type LayoutChangeEvent, ScrollView, Text, View } from "react-native";
import { Image as ExpoImage } from "expo-image";
import { SvgXml } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { AttachmentLibraryEntry } from "@getpaseo/protocol/messages";

import { MarkdownRenderer } from "@/components/markdown/renderer";
import {
  type AttachmentBlob,
  decodeAttachmentText,
  useAttachmentBlob,
} from "@/attachments/attachment-blob";
import { AttachmentDownloadButton } from "@/attachments/attachment-download";
import {
  type AttachmentPreviewKind,
  resolveAttachmentPreviewKind,
} from "@/attachments/attachment-preview-kind";
import { AttachmentPdfView, SUPPORTS_EMBEDDED_PDF } from "@/attachments/attachment-pdf-view";
import { type Theme } from "@/styles/theme";

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface AttachmentPreviewProps {
  serverId: string;
  workspaceId: string;
  entry: AttachmentLibraryEntry;
}

/** True when we can show the file itself rather than a "download it" card. */
function canEmbed(kind: AttachmentPreviewKind): boolean {
  if (kind === "unsupported") {
    return false;
  }
  if (kind === "pdf") {
    return SUPPORTS_EMBEDDED_PDF;
  }
  return true;
}

/**
 * The attachment itself, rendered inside the panel: markdown formatted, images
 * scaled to the panel's width, PDFs in the platform viewer, and a download card
 * for everything else.
 */
export function AttachmentPreview({ serverId, workspaceId, entry }: AttachmentPreviewProps) {
  const kind = useMemo(
    () => resolveAttachmentPreviewKind({ fileName: entry.fileName, mimeType: entry.mimeType }),
    [entry.fileName, entry.mimeType],
  );
  const embeddable = canEmbed(kind);
  const {
    data: blob,
    isLoading,
    error,
  } = useAttachmentBlob({ serverId, workspaceId, entry, enabled: embeddable });

  if (!embeddable) {
    return (
      <UnsupportedPreview
        serverId={serverId}
        workspaceId={workspaceId}
        entry={entry}
        note={
          kind === "pdf"
            ? "Les PDF s'ouvrent dans la visionneuse du téléphone."
            : "Aperçu indisponible pour ce type de fichier."
        }
      />
    );
  }

  if (isLoading && !blob) {
    return (
      <View style={styles.centered}>
        <ThemedActivityIndicator size="small" uniProps={mutedColorMapping} />
      </View>
    );
  }

  if (error || !blob) {
    return (
      <UnsupportedPreview
        serverId={serverId}
        workspaceId={workspaceId}
        entry={entry}
        note={
          error instanceof Error && error.message
            ? error.message
            : "Le contenu de ce fichier n'est plus disponible sur l'hôte."
        }
      />
    );
  }

  return <PreviewBody kind={kind} blob={blob} entry={entry} />;
}

function PreviewBody({
  kind,
  blob,
  entry,
}: {
  kind: AttachmentPreviewKind;
  blob: AttachmentBlob;
  entry: AttachmentLibraryEntry;
}) {
  if (kind === "markdown") {
    return <MarkdownPreview base64={blob.base64} />;
  }
  if (kind === "svg") {
    return <SvgPreview base64={blob.base64} />;
  }
  if (kind === "pdf") {
    return (
      <View style={styles.fill}>
        <AttachmentPdfView
          base64={blob.base64}
          mimeType={blob.mimeType}
          fileName={entry.fileName}
        />
      </View>
    );
  }
  return <ImagePreview dataUrl={blob.dataUrl} fileName={entry.fileName} />;
}

function MarkdownPreview({ base64 }: { base64: string }) {
  const text = useMemo(() => decodeAttachmentText(base64), [base64]);
  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={styles.markdownContent}
      testID="attachment-preview-markdown"
    >
      <MarkdownRenderer text={text} />
    </ScrollView>
  );
}

function SvgPreview({ base64 }: { base64: string }) {
  const xml = useMemo(() => decodeAttachmentText(base64), [base64]);
  return (
    <View style={styles.imageArea} testID="attachment-preview-svg">
      <SvgXml xml={xml} width="100%" height="100%" />
    </View>
  );
}

/**
 * expo-image does not pick a size up from a flex-only style on web, so the area
 * is measured and the image gets explicit pixel dimensions — same fix as the
 * chat lightbox.
 */
function ImagePreview({ dataUrl, fileName }: { dataUrl: string; fileName: string }) {
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox((prev) =>
      prev && prev.width === width && prev.height === height ? prev : { width, height },
    );
  }, []);
  const source = useMemo(() => ({ uri: dataUrl }), [dataUrl]);
  const imageStyle = useMemo(
    () => (box ? { width: box.width, height: box.height } : styles.fill),
    [box],
  );

  return (
    <View style={styles.imageArea} onLayout={handleLayout}>
      <ExpoImage
        source={source}
        contentFit="contain"
        accessibilityLabel={fileName}
        style={imageStyle}
        testID="attachment-preview-image"
      />
    </View>
  );
}

/** "Aperçu indisponible" card — the file is still one tap from being opened. */
function UnsupportedPreview({
  serverId,
  workspaceId,
  entry,
  note,
}: {
  serverId: string;
  workspaceId: string;
  entry: AttachmentLibraryEntry;
  note: string;
}) {
  return (
    <View style={styles.centered} testID="attachment-preview-unsupported">
      <Text style={styles.note}>{note}</Text>
      <AttachmentDownloadButton serverId={serverId} workspaceId={workspaceId} entry={entry} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  fill: {
    flex: 1,
    minHeight: 0,
  },
  markdownContent: {
    padding: theme.spacing[3],
    paddingBottom: theme.spacing[6],
  },
  imageArea: {
    flex: 1,
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[2],
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  error: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
}));

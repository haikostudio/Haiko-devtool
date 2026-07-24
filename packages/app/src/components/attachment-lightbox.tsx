import { useCallback, useEffect, useMemo, useState } from "react";
import { type LayoutChangeEvent, Modal, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image as ExpoImage } from "expo-image";
import { X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { AttachmentMetadata } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { isWeb } from "@/constants/platform";
import { WindowChromeRootRegion, WindowChromeSafeArea } from "@/utils/desktop-window";

interface AttachmentLightboxProps {
  metadata: AttachmentMetadata | null;
  /** Render this URI directly (e.g. a remote image's data URI) instead of resolving from the store. */
  uri?: string | null;
  onClose: () => void;
}

export function AttachmentLightbox({ metadata, uri: directUri, onClose }: AttachmentLightboxProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const resolvedUrl = useAttachmentPreviewUrl(metadata);
  const url = directUri ?? resolvedUrl;
  const isOpen = Boolean(metadata) || Boolean(directUri);
  const [errored, setErrored] = useState(false);
  // expo-image is NOT unistyles-aware and does not pick up a size from an
  // absolute-fill (top/left/right/bottom: 0) style on web — it collapses to ~0px
  // and the full-screen image renders blank even though the thumbnail (which
  // uses an explicit width/height) shows fine. Measure the available area and
  // hand the image explicit pixel dimensions, matching the thumbnail's fix.
  const [imageBox, setImageBox] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    setErrored(false);
  }, [metadata?.id, directUri]);

  const handleImageAreaLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setImageBox((prev) =>
      prev && prev.width === width && prev.height === height ? prev : { width, height },
    );
  }, []);

  useEffect(() => {
    if (!isWeb || !isOpen) return;
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeydown);
    return () => {
      window.removeEventListener("keydown", handleKeydown);
    };
  }, [isOpen, onClose]);

  const closeButtonRowStyle = useMemo(
    () => [
      styles.closeButtonRow,
      {
        top: insets.top + theme.spacing[3],
      },
    ],
    [insets.top, theme.spacing],
  );
  const closeButtonStyle = useMemo(
    () => [styles.closeButton, { marginRight: insets.right + theme.spacing[3] }],
    [insets.right, theme.spacing],
  );

  const handleImageError = useCallback(() => setErrored(true), []);
  const noopPress = useCallback(() => {}, []);
  const imageSource = useMemo(() => ({ uri: url ?? "" }), [url]);
  const imageStyle = useMemo(
    () => (imageBox ? { width: imageBox.width, height: imageBox.height } : imageFillStyle),
    [imageBox],
  );

  if (!isOpen) {
    return null;
  }

  const hasError = errored || !url;

  return (
    <Modal transparent animationType="fade" statusBarTranslucent visible onRequestClose={onClose}>
      <WindowChromeRootRegion corners="both">
        <View style={styles.root}>
          <Pressable
            testID="attachment-lightbox-backdrop"
            accessibilityRole="button"
            accessibilityLabel={t("message.attachments.dismissImage")}
            onPress={onClose}
            style={styles.backdrop}
          />
          <View style={styles.contentLayer}>
            <View style={styles.imageArea}>
              {hasError ? (
                <Text style={styles.errorText}>{t("message.attachments.imageLoadFailed")}</Text>
              ) : (
                <Pressable
                  onPress={noopPress}
                  onLayout={handleImageAreaLayout}
                  style={styles.imagePressable}
                >
                  <ExpoImage
                    testID="attachment-lightbox-image"
                    source={imageSource}
                    contentFit="contain"
                    onError={handleImageError}
                    style={imageStyle}
                  />
                </Pressable>
              )}
            </View>
            <WindowChromeSafeArea placement="inline" style={closeButtonRowStyle}>
              <Pressable
                testID="attachment-lightbox-close"
                accessibilityRole="button"
                accessibilityLabel={t("message.attachments.closeImage")}
                hitSlop={8}
                onPress={onClose}
                style={closeButtonStyle}
              >
                <X size={16} color={theme.colors.foregroundMuted} />
              </Pressable>
            </WindowChromeSafeArea>
          </View>
        </View>
      </WindowChromeRootRegion>
    </Modal>
  );
}

const imageFillStyle = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.9)",
  },
  contentLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: "box-none",
  },
  closeButtonRow: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "flex-end",
    pointerEvents: "box-none",
  },
  imageArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    pointerEvents: "box-none",
  },
  imagePressable: {
    flex: 1,
    width: "100%",
    alignSelf: "center",
    maxWidth: 960,
    maxHeight: 640,
  },
  errorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  closeButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
  },
}));

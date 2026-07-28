import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Pressable,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Gesture } from "react-native-gesture-handler";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ArrowLeft, Search, X } from "lucide-react-native";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import {
  MOBILE_DOCK_SNAP_POINTS,
  MOBILE_DOCK_TOP_GAP,
} from "@/components/tasks/task-dock-geometry";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  FILE_PREVIEW_WIDTH_UNSET,
  PREVIEW_ANIMATION_MS,
  resolveFilePreviewWidth,
} from "./task-file-preview-layout";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedClose = withUnistyles(X);
const ThemedBack = withUnistyles(ArrowLeft);
const ThemedSearch = withUnistyles(Search);

export interface TaskSlideOverPanelProps {
  open: boolean;
  onClose: () => void;
  /**
   * Title, optional back control and optional search row. Compact hands it to
   * the sheet as-is; desktop renders the same three parts itself.
   */
  header: SheetHeader;
  /** testID of the desktop overlay. */
  testID: string;
  /** testID of the compact sheet. */
  sheetTestID: string;
  closeTestID: string;
  closeAccessibilityLabel: string;
  /**
   * Desktop width the user dragged this panel to, and where to write the next
   * one. Omit to keep the panel at its default half-area width with no resize
   * handle. `FILE_PREVIEW_WIDTH_UNSET` means "never dragged".
   */
  resize?: { requestedWidth: number; onRequestWidth: (width: number) => void };
  children: ReactNode;
}

/**
 * The board's slide-over: a panel that comes in from the right edge of the area
 * it is mounted in, floating over the timeline and the columns without resizing
 * anything behind it (unlike the explorer side panel, which splits the row).
 *
 * Shared chrome — geometry, animation, Esc handling, header row — for the file
 * preview and the attachments library. Compact falls back to the full-height
 * sheet the board's other drawers use, because half a phone width would be
 * unreadable.
 */
export function TaskSlideOverPanel(props: TaskSlideOverPanelProps) {
  const isCompact = useIsCompactFormFactor();
  return isCompact ? <CompactSlideOver {...props} /> : <DesktopSlideOver {...props} />;
}

function CompactSlideOver({
  open,
  onClose,
  header,
  sheetTestID,
  children,
}: TaskSlideOverPanelProps) {
  return (
    <AdaptiveModalSheet
      header={header}
      visible={open}
      onClose={onClose}
      scrollable={false}
      // Same geometry as the board's other drawers: everything below the app
      // header, so the content is readable instead of squeezed into a half sheet.
      snapPoints={MOBILE_DOCK_SNAP_POINTS}
      compactTopInsetExtra={MOBILE_DOCK_TOP_GAP}
      contentPaddingScale={0}
      contentVerticalPaddingScale={0}
      testID={sheetTestID}
    >
      <View style={styles.body}>{children}</View>
    </AdaptiveModalSheet>
  );
}

function DesktopSlideOver({
  open,
  onClose,
  header,
  testID,
  closeTestID,
  closeAccessibilityLabel,
  resize,
  children,
}: TaskSlideOverPanelProps) {
  // Measured against the AREA the overlay covers, not the window: the board sits
  // between the projects rail and whatever side panels are open. The overlay
  // layer stays mounted so its width is already measured when the panel opens,
  // and the slide-in starts from the right edge instead of from zero.
  const { width: viewportWidth } = useWindowDimensions();
  const [areaWidth, setAreaWidth] = useState(viewportWidth);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => setAreaWidth(event.nativeEvent.layout.width),
    [],
  );
  const width = resolveFilePreviewWidth({
    requestedWidth: resize?.requestedWidth ?? FILE_PREVIEW_WIDTH_UNSET,
    areaWidth,
  });

  // Stays mounted through the closing animation; the timing callback unmounts it.
  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(open ? 1 : 0);
  // The gesture reads its starting width off a ref: the shared value is written
  // on every frame, so it can't double as the drag origin. Same split as the
  // explorer side panel's handle.
  const startWidthRef = useRef(width);
  const resizeWidth = useSharedValue(width);
  const onRequestWidth = resize?.onRequestWidth;

  useEffect(() => {
    resizeWidth.value = width;
  }, [resizeWidth, width]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onStart(() => {
          startWidthRef.current = width;
          resizeWidth.value = width;
        })
        .onUpdate((event) => {
          // Dragging the left edge leftwards widens the panel, hence the minus.
          resizeWidth.value = resolveFilePreviewWidth({
            requestedWidth: startWidthRef.current - event.translationX,
            areaWidth,
          });
        })
        .onEnd(() => {
          if (onRequestWidth) {
            runOnJS(onRequestWidth)(resizeWidth.value);
          }
        }),
    [areaWidth, onRequestWidth, resizeWidth, width],
  );

  useEffect(() => {
    if (open) {
      setMounted(true);
    }
    progress.value = withTiming(
      open ? 1 : 0,
      { duration: PREVIEW_ANIMATION_MS, easing: Easing.out(Easing.cubic) },
      (finished) => {
        if (finished && !open) {
          runOnJS(setMounted)(false);
        }
      },
    );
  }, [open, progress]);

  // Esc closes on web only — native has the visible close button and the OS back
  // gesture, and `document` does not exist there.
  useEffect(() => {
    if (!isWeb || !open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  // Width lives on the UI thread so a drag resizes at gesture speed; the slide-in
  // is anchored to it, so the panel always enters from its own right edge.
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    width: resizeWidth.value,
    transform: [{ translateX: (1 - progress.value) * resizeWidth.value }],
  }));
  const panelStyle = useMemo(() => [staticStyles.panel, animatedStyle], [animatedStyle]);

  return (
    // box-none: the overlay layer itself must not swallow clicks meant for the
    // board sitting under the half it does not cover.
    <View style={staticStyles.overlay} pointerEvents="box-none" onLayout={handleLayout}>
      {mounted ? (
        <Animated.View style={panelStyle} testID={testID}>
          <View style={styles.panelSurface}>
            {onRequestWidth ? (
              <SidebarResizeHandle
                edge="left"
                gesture={resizeGesture}
                testID={`${testID}-resize-handle`}
              />
            ) : null}
            <View style={styles.header}>
              {header.back ? (
                <Pressable
                  onPress={header.back.onPress}
                  style={styles.iconButton}
                  accessibilityRole="button"
                  accessibilityLabel={header.back.accessibilityLabel ?? header.back.label}
                  testID={`${testID}-back`}
                  hitSlop={8}
                >
                  <ThemedBack size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
                </Pressable>
              ) : null}
              <Text style={styles.title} numberOfLines={1}>
                {header.title}
              </Text>
              {header.actions}
              <Pressable
                onPress={onClose}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel={closeAccessibilityLabel}
                testID={closeTestID}
                hitSlop={8}
              >
                <ThemedClose size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
              </Pressable>
            </View>
            {header.search ? (
              <View style={styles.searchRow}>
                <ThemedSearch size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
                <AdaptiveTextInput
                  // @ts-expect-error - outlineStyle is web-only
                  style={SEARCH_INPUT_STYLE}
                  placeholder={header.search.placeholder}
                  resetKey={header.search.resetKey}
                  onChangeText={header.search.onChange}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus={header.search.autoFocus}
                  testID={header.search.testID}
                />
              </View>
            ) : null}
            <View style={styles.body}>{children}</View>
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

// Reanimated drives this node's transform, so its layout stays out of Unistyles'
// hands — same split as the explorer side panel.
const staticStyles = RNStyleSheet.create({
  overlay: {
    ...RNStyleSheet.absoluteFillObject,
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  panel: {
    height: "100%",
  },
});

const styles = StyleSheet.create((theme) => ({
  panelSurface: {
    flex: 1,
    minWidth: 0,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    ...theme.shadow.lg,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: {
    flex: 1,
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  iconButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  searchInput: {
    flex: 1,
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  // The content owns its own scroll, so the body is a bounded flex column.
  body: {
    flex: 1,
    minHeight: 0,
  },
}));

const SEARCH_INPUT_STYLE = [styles.searchInput, isWeb && { outlineStyle: "none" }];

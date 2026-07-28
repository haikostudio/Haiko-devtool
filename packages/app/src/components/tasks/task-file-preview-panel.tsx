import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { useTranslation } from "react-i18next";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import {
  MOBILE_DOCK_SNAP_POINTS,
  MOBILE_DOCK_TOP_GAP,
} from "@/components/tasks/task-dock-geometry";
import { FilePane } from "@/file-pane/pane";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { getFileNameFromPath } from "@/attachments/utils";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { resolveFilePreviewWidth, PREVIEW_ANIMATION_MS } from "./task-file-preview-layout";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedClose = withUnistyles(X);

export interface TaskFilePreviewPanelProps {
  serverId: string | null;
  /** Absolute path of the project's root checkout — the read is relative to it. */
  projectRootPath: string | null;
}

/**
 * Reads the board's preview selection and keeps the last non-null path alive for
 * the length of the closing animation, so the panel slides out showing the file
 * it was showing instead of blanking the instant it is dismissed.
 */
function usePreviewSelection() {
  const filePath = useTasksBoardUiStore((state) => state.previewFilePath);
  const setFilePath = useTasksBoardUiStore((state) => state.setPreviewFilePath);
  const lastPathRef = useRef<string | null>(filePath);
  if (filePath) {
    lastPathRef.current = filePath;
  }
  const close = useCallback(() => setFilePath(null), [setFilePath]);
  return { filePath, displayedPath: lastPathRef.current, close };
}

/**
 * The board's file preview: tapping a file in the explorer tree opens its
 * contents here (syntax highlighting, markdown preview and images all come from
 * the shared `FilePane`, same as the workspace's file tabs).
 *
 * Desktop is an overlay sliding in from the right edge of the board area over
 * the timeline and the kanban — nothing behind it is resized, unlike the
 * explorer side panel which splits the row. Compact falls back to the standard
 * full-height sheet the other board drawers use, because half a phone width
 * would be unreadable.
 */
export function TaskFilePreviewPanel(props: TaskFilePreviewPanelProps) {
  const isCompact = useIsCompactFormFactor();
  useClearPreviewOnProjectChange(props.projectRootPath);
  return isCompact ? <CompactFilePreview {...props} /> : <DesktopFilePreview {...props} />;
}

/**
 * Switching projects drops the preview: the open path belongs to the previous
 * checkout, and reading it against the new root would either fail or, worse,
 * silently show a same-named file from somewhere else.
 */
function useClearPreviewOnProjectChange(projectRootPath: string | null) {
  const setFilePath = useTasksBoardUiStore((state) => state.setPreviewFilePath);
  const previousRootRef = useRef(projectRootPath);
  useEffect(() => {
    if (previousRootRef.current !== projectRootPath) {
      previousRootRef.current = projectRootPath;
      setFilePath(null);
    }
  }, [projectRootPath, setFilePath]);
}

function CompactFilePreview({ serverId, projectRootPath }: TaskFilePreviewPanelProps) {
  const { filePath, displayedPath, close } = usePreviewSelection();
  const header = useMemo(
    () => ({ title: getFileNameFromPath(displayedPath) ?? displayedPath ?? "" }),
    [displayedPath],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={Boolean(filePath)}
      onClose={close}
      scrollable={false}
      // Same geometry as the board's other drawers: everything below the app
      // header, so a file is readable instead of squeezed into a half sheet.
      snapPoints={MOBILE_DOCK_SNAP_POINTS}
      compactTopInsetExtra={MOBILE_DOCK_TOP_GAP}
      contentPaddingScale={0}
      contentVerticalPaddingScale={0}
      testID="tasks-file-preview-sheet"
    >
      <View style={styles.body}>
        <PreviewBody
          serverId={serverId}
          projectRootPath={projectRootPath}
          filePath={displayedPath}
        />
      </View>
    </AdaptiveModalSheet>
  );
}

function DesktopFilePreview({ serverId, projectRootPath }: TaskFilePreviewPanelProps) {
  const { t } = useTranslation();
  const { filePath, displayedPath, close } = usePreviewSelection();
  // Half of the AREA the overlay covers, not half the window: the board sits
  // between the projects rail and whatever side panels are open. The overlay
  // layer stays mounted so its width is already measured when a file is tapped,
  // and the slide-in starts from the right edge instead of from zero.
  const { width: viewportWidth } = useWindowDimensions();
  const [areaWidth, setAreaWidth] = useState(viewportWidth);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => setAreaWidth(event.nativeEvent.layout.width),
    [],
  );
  const width = resolveFilePreviewWidth(areaWidth);

  const open = Boolean(filePath);
  // Stays mounted through the closing animation; the timing callback unmounts it.
  const [mounted, setMounted] = useState(open);
  const progress = useSharedValue(open ? 1 : 0);

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
        close();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [close, open]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateX: (1 - progress.value) * width }],
  }));
  const panelStyle = useMemo(
    () => [staticStyles.panel, { width }, animatedStyle],
    [animatedStyle, width],
  );

  return (
    // box-none: the overlay layer itself must not swallow clicks meant for the
    // board sitting under the half it does not cover.
    <View style={staticStyles.overlay} pointerEvents="box-none" onLayout={handleLayout}>
      {mounted ? (
        <Animated.View style={panelStyle} testID="tasks-file-preview-panel">
          <View style={styles.panelSurface}>
            <View style={styles.header}>
              <Text style={styles.title} numberOfLines={1}>
                {getFileNameFromPath(displayedPath) ?? displayedPath ?? ""}
              </Text>
              <Pressable
                onPress={close}
                style={styles.closeButton}
                accessibilityRole="button"
                accessibilityLabel={t("tasks.filePreview.close")}
                testID="tasks-file-preview-close"
                hitSlop={8}
              >
                <ThemedClose size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
              </Pressable>
            </View>
            <View style={styles.body}>
              <PreviewBody
                serverId={serverId}
                projectRootPath={projectRootPath}
                filePath={displayedPath}
              />
            </View>
          </View>
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * The file itself. Keyed by path so switching files remounts the reader with a
 * clean state while the panel stays open — no close/re-open flicker.
 */
function PreviewBody({
  serverId,
  projectRootPath,
  filePath,
}: {
  serverId: string | null;
  projectRootPath: string | null;
  filePath: string | null;
}) {
  const { t } = useTranslation();
  const location = useMemo(() => (filePath ? { path: filePath } : null), [filePath]);

  if (!serverId || !projectRootPath || !location) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>{t("tasks.explorer.noProject")}</Text>
      </View>
    );
  }
  return (
    <FilePane
      key={location.path}
      serverId={serverId}
      workspaceRoot={projectRootPath}
      location={location}
      navigationRevision={0}
    />
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
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  closeButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  // The reader owns its own scroll, so the body is a bounded flex column.
  body: {
    flex: 1,
    minHeight: 0,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

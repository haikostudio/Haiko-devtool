import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Pressable,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Gesture } from "react-native-gesture-handler";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { FolderTree, X } from "lucide-react-native";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { resolveDesktopExplorerWidth } from "@/components/desktop-sidebar-layout";
import { useReserveFloatingRightInset } from "@/hooks/use-floating-right-inset";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedTree = withUnistyles(FolderTree);
const ThemedClose = withUnistyles(X);

/**
 * Width of the projects rail the board sits next to. The explorer splits what is
 * left of the viewport with the board, so the rail has to come off the budget
 * before clamping — otherwise the board could be squeezed below its minimum.
 */
const PROJECTS_RAIL_WIDTH = 264;

export interface TaskExplorerSidePanelProps {
  serverId: string | null;
  workspaceId: string | null;
  /** Absolute path of the project's root checkout — the tree's starting point. */
  projectRootPath: string | null;
}

/**
 * The project's file tree as a right-hand side panel: it shares the row's width
 * with the board (the board shrinks, nothing is covered) and its left edge is
 * draggable to trade width between the two.
 *
 * Desktop only — the compact form factor keeps the bottom dock, where a side
 * panel would leave neither pane usable.
 */
export function TaskExplorerSidePanel({
  serverId,
  workspaceId,
  projectRootPath,
}: TaskExplorerSidePanelProps) {
  const { t } = useTranslation();
  const open = useTasksBoardUiStore((state) => state.explorerOpen);
  const setOpen = useTasksBoardUiStore((state) => state.setExplorerOpen);
  const requestedWidth = useTasksBoardUiStore((state) => state.explorerWidth);
  const setWidth = useTasksBoardUiStore((state) => state.setExplorerWidth);
  // Tapping a file hands it to the board's preview overlay (see
  // task-file-preview-panel.tsx); the tree itself stays open beside it so the
  // next file is one click away.
  const setPreviewFilePath = useTasksBoardUiStore((state) => state.setPreviewFilePath);

  const { width: viewportWidth } = useWindowDimensions();
  const availableWidth = Math.max(0, viewportWidth - PROJECTS_RAIL_WIDTH);
  const visibleWidth = resolveDesktopExplorerWidth({
    requestedWidth,
    viewportWidth: availableWidth,
  });
  // The gesture reads the width it started from off a ref: the shared value is
  // written on every frame, so it can't double as the drag origin.
  const startWidthRef = useRef(visibleWidth);
  const resizeWidth = useSharedValue(visibleWidth);

  useEffect(() => {
    resizeWidth.value = visibleWidth;
  }, [resizeWidth, visibleWidth]);

  const handleClose = useCallback(() => setOpen(false), [setOpen]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onStart(() => {
          startWidthRef.current = visibleWidth;
          resizeWidth.value = visibleWidth;
        })
        .onUpdate((event) => {
          // Dragging the left edge leftwards widens the panel, hence the minus.
          resizeWidth.value = resolveDesktopExplorerWidth({
            requestedWidth: startWidthRef.current - event.translationX,
            viewportWidth: availableWidth,
          });
        })
        .onEnd(() => {
          runOnJS(setWidth)(resizeWidth.value);
        }),
    [availableWidth, resizeWidth, setWidth, visibleWidth],
  );

  // Same reservation as the conductor column: the root-mounted toast pile is
  // positioned against the window, so it has to know how much of the right edge
  // this panel eats — live, while the edge is being dragged.
  useReserveFloatingRightInset("tasksExplorer", resizeWidth, open);

  const widthStyle = useAnimatedStyle(() => ({ width: resizeWidth.value }));
  const panelStyle = useMemo(() => [staticStyles.panel, widthStyle], [widthStyle]);

  if (!open) {
    return null;
  }

  return (
    <Animated.View style={panelStyle} testID="tasks-explorer-side-panel">
      <View style={styles.panelBorder}>
        <SidebarResizeHandle
          edge="left"
          gesture={resizeGesture}
          testID="tasks-explorer-resize-handle"
        />
        <View style={styles.header}>
          <View style={styles.headerTitle}>
            <ThemedTree size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
            <Text style={styles.title} numberOfLines={1}>
              {t("tasks.explorer.title")}
            </Text>
          </View>
          <Pressable
            onPress={handleClose}
            style={styles.closeButton}
            accessibilityRole="button"
            accessibilityLabel={t("workspace.tabs.explorer.close")}
            testID="tasks-explorer-side-panel-close"
            hitSlop={8}
          >
            <ThemedClose size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          </Pressable>
        </View>
        <View style={styles.body}>
          {serverId && projectRootPath ? (
            <FileExplorerPane
              serverId={serverId}
              workspaceId={workspaceId}
              workspaceRoot={projectRootPath}
              onOpenFile={setPreviewFilePath}
            />
          ) : (
            <View style={styles.centered}>
              <Text style={styles.emptyText}>{t("tasks.explorer.noProject")}</Text>
            </View>
          )}
        </View>
      </View>
    </Animated.View>
  );
}

// Reanimated owns this node's layout, so it stays out of Unistyles' hands — see
// the same split in explorer-sidebar.tsx.
const staticStyles = RNStyleSheet.create({
  panel: {
    position: "relative",
  },
});

const styles = StyleSheet.create((theme) => ({
  panelBorder: {
    flex: 1,
    minWidth: 0,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  header: {
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
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
  // The tree owns its own scroll, so the body is a bounded flex column.
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

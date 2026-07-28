import { useEffect, useMemo, useRef } from "react";
import {
  Pressable,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { useIsFocused } from "@react-navigation/native";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Gesture } from "react-native-gesture-handler";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronLeft, X } from "lucide-react-native";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { resolveDesktopExplorerWidth } from "@/components/desktop-sidebar-layout";
import {
  useConductorController,
  type ConductorPanelProps,
} from "@/components/tasks/conductor-panel";
import type { TaskDockHeader } from "@/components/tasks/task-bottom-dock";
import { useReserveFloatingRightInset } from "@/hooks/use-floating-right-inset";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedClose = withUnistyles(X);

/**
 * Width of the projects rail the board sits next to. Mirrors the explorer side
 * panel: the conductor splits what is left of the viewport with the board, so the
 * rail has to come off the budget before clamping — otherwise the board could be
 * squeezed below its minimum.
 */
const PROJECTS_RAIL_WIDTH = 264;

/**
 * The "Chef d'orchestre" chat (and, when a card is tapped, that task's Chat /
 * Details / Billing tabs) as a right-hand side panel — the exact concept as the
 * project file explorer's side panel: it shares the row's width with the board
 * (the board shrinks, nothing is covered), its left edge is draggable to trade
 * width between the two, and the width is remembered across reloads.
 *
 * Desktop only — the compact form factor keeps the bottom sheet, where a side
 * panel would leave neither pane usable. All the conductor's state and behavior
 * come from `useConductorController`, shared with the compact `ConductorPanel`.
 */
export function ConductorSidePanel(props: ConductorPanelProps) {
  const { header, body } = useConductorController(props);
  const requestedWidth = useTasksBoardUiStore((state) => state.conductorPanelWidth);
  const setWidth = useTasksBoardUiStore((state) => state.setConductorPanelWidth);

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

  // Floating overlays mounted at the app root (the agent-tasks toast pile) are
  // positioned against the window, so they'd sit on top of this panel. Publish the
  // live width — the one the resize gesture writes on every frame — and they keep
  // to the board's side of the row, following the drag in real time.
  //
  // Gated on screen focus: the tasks screen stays mounted underneath when a chat
  // route is pushed on top of it, and a reservation left standing there would
  // shift the pile on a screen that has no side panel at all.
  const isFocused = useIsFocused();
  useReserveFloatingRightInset("tasksConductor", resizeWidth, isFocused);

  const widthStyle = useAnimatedStyle(() => ({ width: resizeWidth.value }));
  const panelStyle = useMemo(() => [staticStyles.panel, widthStyle], [widthStyle]);

  return (
    <Animated.View style={panelStyle} testID="conductor-side-panel">
      <View style={styles.panelBorder}>
        <SidebarResizeHandle
          edge="left"
          gesture={resizeGesture}
          testID="conductor-side-panel-resize-handle"
        />
        <ConductorSidePanelHeader header={header} onClose={props.onClose} />
        <View style={styles.body}>{body}</View>
      </View>
    </Animated.View>
  );
}

function ConductorSidePanelHeader({
  header,
  onClose,
}: {
  header: TaskDockHeader;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.header}>
      {header.back ? (
        <Pressable
          onPress={header.back.onPress}
          accessibilityRole="button"
          accessibilityLabel={header.back.accessibilityLabel ?? t("common.actions.back")}
          style={styles.iconButton}
          testID="conductor-side-panel-back"
          hitSlop={8}
        >
          <ThemedChevronLeft size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </Pressable>
      ) : null}
      {header.leading ? <View style={styles.leadingSlot}>{header.leading}</View> : null}
      <Text style={styles.title} numberOfLines={1}>
        {header.title}
      </Text>
      {header.actions ? <View style={styles.actionsSlot}>{header.actions}</View> : null}
      <Pressable
        onPress={onClose}
        style={styles.iconButton}
        accessibilityRole="button"
        accessibilityLabel={t("common.actions.close")}
        testID="conductor-side-panel-close"
        hitSlop={8}
      >
        <ThemedClose size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      </Pressable>
    </View>
  );
}

// Reanimated owns this node's layout, so it stays out of Unistyles' hands — see
// the same split in explorer-sidebar.tsx / task-explorer-side-panel.tsx.
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
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  leadingSlot: {
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  actionsSlot: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  iconButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  // The embedded chat / task tabs own their own scroll, so the body is a bounded
  // flex column.
  body: {
    flex: 1,
    minHeight: 0,
  },
}));

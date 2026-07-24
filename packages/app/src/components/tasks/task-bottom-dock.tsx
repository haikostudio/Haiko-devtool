import { useCallback, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { Pressable, Text, useWindowDimensions, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { ChevronDown, ChevronLeft, ChevronUp, GripHorizontal, X } from "lucide-react-native";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedX = withUnistyles(X);
const ThemedGrip = withUnistyles(GripHorizontal);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);

// Height bounds: never shorter than a usable chat, never taller than 90% of the
// viewport (leaving the board peeking above so the dock reads as a drawer, not a
// full-screen takeover). Width caps at 960px on desktop; full-width on mobile.
const MIN_HEIGHT = 220;
const MAX_HEIGHT_RATIO = 0.9;
const DESKTOP_MAX_WIDTH = 960;
const SCREEN_MARGIN = 16;
// Mobile: the shared sheet handles height via its own pan/snap; cap at 90%.
const MOBILE_SNAP_POINTS = ["90%"];

// RN's ViewStyle `cursor` only types auto|pointer; the row/move cursors are
// web-valid, so apply them as a web-only escape hatch outside stricter typing.
const rowResizeCursor: ViewStyle | undefined = isWeb
  ? ({ cursor: "row-resize" } as unknown as ViewStyle)
  : undefined;
const moveCursor: ViewStyle | undefined = isWeb
  ? ({ cursor: "move" } as unknown as ViewStyle)
  : undefined;

export interface TaskDockHeader {
  title: string;
  /** Optional leading icon (e.g. the conductor wand) shown before the title. */
  leading?: ReactNode;
  /** Optional back control (task mode returns to the conductor). */
  back?: { onPress: () => void; accessibilityLabel?: string };
  /** Optional trailing actions (e.g. the "Details" button), before the dock's own controls. */
  actions?: ReactNode;
}

export interface TaskBottomDockProps {
  visible: boolean;
  header: TaskDockHeader;
  children: ReactNode;
  onClose: () => void;
  /** Persisted dock height (px, desktop only). */
  height: number;
  /** Persisted horizontal offset from centered (px, desktop only). */
  offsetX: number;
  /** Persisted collapsed state (desktop only): header-only when true. */
  collapsed: boolean;
  onResize: (height: number) => void;
  onMove: (offsetX: number) => void;
  onToggleCollapse: () => void;
  /**
   * Fired on the first touch that lands inside the dock body — a tap or the
   * start of a scroll. Observed via a non-capturing responder so it never steals
   * the gesture (scrolling and inner buttons keep working). Header controls
   * (close/collapse/drag) sit outside the body and don't trigger it.
   */
  onInteraction?: () => void;
  desktopMaxWidth?: number;
  testID?: string;
}

/**
 * The task board's shared drawer. On mobile it's the standard `AdaptiveModalSheet`
 * bottom sheet (full width, 90% tall). On desktop it's a drawer docked to the
 * bottom edge that the user can drag left/right, resize (drag the top edge, up to
 * 90% of the viewport), and collapse to a title bar — never a modal floating in
 * the middle of the screen. Geometry (height / horizontal offset / collapsed) is
 * owned by the caller (persisted per drawer in the tasks board store), so each
 * drawer remembers where the user put it.
 */
export function TaskBottomDock(props: TaskBottomDockProps) {
  const isCompact = useIsCompactFormFactor();
  if (isCompact) {
    return <MobileDockSheet {...props} />;
  }
  if (!props.visible) {
    return null;
  }
  return <DesktopBottomDock {...props} />;
}

// Compact: the standard bottom sheet. Drag/resize/collapse are desktop
// affordances the sheet's own pan/snap already covers.
// Non-capturing responder that reports the first touch (tap or scroll start)
// inside the body WITHOUT becoming the responder: returning false leaves the
// gesture to the content, so scrolling and inner presses stay untouched.
function useInteractionSniffer(onInteraction?: () => void) {
  return useCallback(() => {
    onInteraction?.();
    return false;
  }, [onInteraction]);
}

function MobileDockSheet({
  visible,
  header,
  children,
  onClose,
  onInteraction,
  testID,
}: TaskBottomDockProps) {
  const sniff = useInteractionSniffer(onInteraction);
  const sheetHeader = useMemo<SheetHeader>(
    () => ({
      title: header.title,
      ...(header.leading ? { leading: header.leading } : {}),
      ...(header.back
        ? {
            back: {
              onPress: header.back.onPress,
              accessibilityLabel: header.back.accessibilityLabel,
            },
          }
        : {}),
      ...(header.actions ? { actions: header.actions } : {}),
    }),
    [header.title, header.leading, header.back, header.actions],
  );
  return (
    <AdaptiveModalSheet
      header={sheetHeader}
      visible={visible}
      onClose={onClose}
      scrollable={false}
      snapPoints={MOBILE_SNAP_POINTS}
      // The dock's inner sections (tabs, chat, forms) each own their horizontal
      // padding, so drop the sheet's outer indent and let the content hug the
      // edges — otherwise it's doubly inset and reads as a fat margin.
      contentPaddingScale={0}
      testID={testID}
    >
      <View
        style={styles.mobileBody}
        onStartShouldSetResponderCapture={onInteraction ? sniff : undefined}
      >
        {children}
      </View>
    </AdaptiveModalSheet>
  );
}

// Desktop: a drawer docked to the bottom edge, draggable left/right, resizable
// (drag the top edge, capped at 90% of the viewport), and collapsible to its
// title bar. Geometry is owned by the caller so each drawer remembers its place.
function DesktopBottomDock({
  header,
  children,
  onClose,
  height,
  offsetX,
  collapsed,
  onResize,
  onMove,
  onToggleCollapse,
  onInteraction,
  desktopMaxWidth = DESKTOP_MAX_WIDTH,
  testID,
}: TaskBottomDockProps) {
  const { t } = useTranslation();
  const sniff = useInteractionSniffer(onInteraction);
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  // Live geometry refs so the pan gestures read the current value at gesture
  // start without re-creating the gesture on every store update.
  const offsetRef = useRef(offsetX);
  offsetRef.current = offsetX;
  const heightRef = useRef(height);
  heightRef.current = height;
  const getOffset = useCallback(() => offsetRef.current, []);
  const getHeight = useCallback(() => heightRef.current, []);

  const maxHeight = Math.min(
    Math.round(screenHeight * MAX_HEIGHT_RATIO),
    screenHeight - insets.top - 24,
  );
  const clampedHeight = Math.min(maxHeight, Math.max(MIN_HEIGHT, height));
  const width = Math.min(desktopMaxWidth, screenWidth - SCREEN_MARGIN * 2);
  // Keep the panel fully on-screen whichever way the user drags it.
  const maxOffset = Math.max(0, (screenWidth - width) / 2 - SCREEN_MARGIN);
  const clampedOffsetX = Math.min(maxOffset, Math.max(-maxOffset, offsetX));

  const panelStyle = useMemo(
    () => [
      styles.panel,
      {
        width,
        transform: [{ translateX: clampedOffsetX }],
        ...(collapsed ? {} : { height: clampedHeight }),
      },
    ],
    [width, clampedOffsetX, collapsed, clampedHeight],
  );

  return (
    <View style={styles.dockRoot} pointerEvents="box-none">
      <View style={panelStyle} testID={testID}>
        {collapsed ? null : (
          <HeightResizeHandle getHeight={getHeight} maxHeight={maxHeight} onResize={onResize} />
        )}
        <View style={styles.header}>
          {header.back ? (
            <Pressable
              onPress={header.back.onPress}
              accessibilityRole="button"
              accessibilityLabel={header.back.accessibilityLabel ?? t("common.actions.back")}
              style={styles.headerButton}
              testID="task-dock-back"
            >
              <ThemedChevronLeft size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
            </Pressable>
          ) : null}
          {header.leading ? <View style={styles.leadingSlot}>{header.leading}</View> : null}
          <Text style={styles.title} numberOfLines={1}>
            {header.title}
          </Text>
          {header.actions}
          <HorizontalDragHandle getOffset={getOffset} onMove={onMove} />
          <Pressable
            onPress={onToggleCollapse}
            accessibilityRole="button"
            accessibilityLabel={
              collapsed ? t("tasks.conductor.expand") : t("tasks.conductor.collapse")
            }
            style={styles.headerButton}
            testID="task-dock-collapse"
          >
            {collapsed ? (
              <ThemedChevronUp size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
            ) : (
              <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
            )}
          </Pressable>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t("common.actions.close")}
            style={styles.headerButton}
            testID="task-dock-close"
          >
            <ThemedX size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          </Pressable>
        </View>
        {/* Kept mounted while collapsed (display:none) so the live agent chat
            keeps its scroll/terminal state instead of re-mounting on expand. */}
        <View
          style={collapsed ? styles.bodyHidden : styles.body}
          onStartShouldSetResponderCapture={onInteraction ? sniff : undefined}
        >
          {children}
        </View>
      </View>
    </View>
  );
}

// Top-edge bar that resizes the panel HEIGHT. Uses gesture-handler's Pan (which
// tracks the pointer globally) so the drag survives the cursor leaving the handle
// — the RN responder system used to drop the drag there. `runOnJS` keeps the
// callbacks on the JS thread so they can write the store.
function HeightResizeHandle({
  getHeight,
  maxHeight,
  onResize,
}: {
  getHeight: () => number;
  maxHeight: number;
  onResize: (height: number) => void;
}) {
  const startRef = useRef(0);
  const handleStyle = useMemo(() => [styles.resizeHandle, rowResizeCursor], []);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .hitSlop({ top: 8, bottom: 8 })
        .onStart(() => {
          startRef.current = getHeight();
        })
        .onUpdate((event) => {
          // Top handle: dragging up (negative translationY) grows the panel.
          const next = startRef.current - event.translationY;
          onResize(Math.min(maxHeight, Math.max(MIN_HEIGHT, next)));
        }),
    [getHeight, maxHeight, onResize],
  );
  return (
    <GestureDetector gesture={gesture}>
      <View style={handleStyle} accessibilityRole="adjustable">
        <View style={styles.resizeHandleLine} />
      </View>
    </GestureDetector>
  );
}

// Header grip that moves the panel HORIZONTALLY. Same gesture-handler approach so
// the move keeps tracking once the cursor leaves the grip.
function HorizontalDragHandle({
  getOffset,
  onMove,
}: {
  getOffset: () => number;
  onMove: (offsetX: number) => void;
}) {
  const { t } = useTranslation();
  const startRef = useRef(0);
  const handleStyle = useMemo(() => [styles.dragHandle, moveCursor], []);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .onStart(() => {
          startRef.current = getOffset();
        })
        .onUpdate((event) => {
          onMove(startRef.current + event.translationX);
        }),
    [getOffset, onMove],
  );
  return (
    <GestureDetector gesture={gesture}>
      <View
        style={handleStyle}
        accessibilityRole="adjustable"
        accessibilityLabel={t("tasks.conductor.move")}
      >
        <ThemedGrip size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Bottom-centered dock container that lets taps pass through to the board
  // everywhere except the panel itself.
  dockRoot: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    paddingBottom: theme.spacing[3],
  },
  panel: {
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  resizeHandle: {
    height: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  resizeHandleLine: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  leadingSlot: {
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  dragHandle: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  headerButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  bodyHidden: {
    display: "none",
  },
  mobileBody: {
    flex: 1,
    minHeight: 0,
  },
}));

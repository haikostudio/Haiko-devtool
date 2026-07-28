import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { Trash2 } from "lucide-react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDraggableToast, useToastSection } from "@/hooks/use-draggable-toast";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { TaskToast, useTrackedTasks } from "@/components/agent-tasks-toast-stack";
import {
  ToastClearMenu,
  ToastUndoPill,
  useToastClearActions,
} from "@/components/agent-tasks-toast-controls";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

// Matches theme.spacing[4]; kept a literal so the container can add the safe-area
// inset without subscribing the whole component to the theme runtime.
const BASE_BOTTOM_OFFSET = 16;
// Matches the container's `right: theme.spacing[4]`; kept as a literal so the
// drag math can clamp the button to the viewport without the theme runtime.
const BASE_RIGHT_OFFSET = 16;
// Clear the message composer that lives along the bottom edge on the compact
// chat screen so the button floats above it instead of overlapping the input.
const COMPOSER_CLEARANCE = 140;
// Sit the list close to the sheet edges (spacing[4]) instead of the header's
// wide default indent (spacing[6]) so the cards read as full-width rows.
const DRAWER_CONTENT_PADDING_SCALE = 4;
// Home-indicator clearance used only when the sheet's own safe-area inset comes
// back as 0 (see listStyle) — keeps the last card off the bottom edge.
const DRAWER_BOTTOM_SAFE_AREA_FALLBACK = 28;

// Compact-only counterpart to AgentTasksToastStack: a round badge in the
// bottom-right corner showing how many agent tasks are being tracked. Tapping it
// opens a drawer listing the same toasts the desktop stack renders inline.
export function AgentTasksToastFab(): ReactElement | null {
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const visible = useTrackedTasks();
  const [open, setOpen] = useState(false);
  const section = useToastSection();

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);

  // Free drag, clamped to the viewport and remembered per app section, so the
  // button keeps a separate parked spot in chat vs. the tasks board. A tap still
  // opens the drawer — the gesture only kicks in past a small travel threshold.
  const bottomOffset = BASE_BOTTOM_OFFSET + COMPOSER_CLEARANCE + insets.bottom;
  const { gesture, animatedStyle, onLayout } = useDraggableToast({
    placement: "fab",
    section,
    rightOffset: BASE_RIGHT_OFFSET,
    bottomOffset,
  });

  const containerStyle = useMemo(
    () => [styles.container, inlineUnistylesStyle({ bottom: bottomOffset }), animatedStyle],
    [bottomOffset, animatedStyle],
  );

  // Keep the drawer mounted while it animates closed even after the last toast
  // disappears, but don't render the button once there's nothing to show.
  if (!isCompact || (visible.length === 0 && !open)) {
    return null;
  }

  return (
    <>
      <Animated.View style={containerStyle} pointerEvents="box-none" onLayout={onLayout}>
        <GestureDetector gesture={gesture}>
          <Pressable
            style={fabPressableStyle}
            onPress={handleOpen}
            accessibilityRole="button"
            accessibilityLabel={t("agentTasks.openDrawer", { count: visible.length })}
            testID="agent-tasks-toast-fab"
          >
            <Text style={styles.count}>{visible.length}</Text>
          </Pressable>
        </GestureDetector>
      </Animated.View>
      <AgentTasksToastDrawer visible={open} onClose={handleClose} tasks={visible} />
    </>
  );
}

function AgentTasksToastDrawer({
  visible,
  onClose,
  tasks,
}: {
  visible: boolean;
  onClose: () => void;
  tasks: ReturnType<typeof useTrackedTasks>;
}): ReactElement {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // Same rules as the desktop pile, straight from the shared hook: the trash
  // clears only finished tasks, the menu clears one category at a time, and any
  // clear can be taken back for a few seconds.
  const { counts, finishedCount, clearFinished, clearCategory, canUndo, undoCount, undo } =
    useToastClearActions(tasks);
  const hasFinished = finishedCount > 0;

  // An emptied drawer closes itself rather than leaving the user staring at the
  // "nothing in progress" line — but only once the undo offer has expired, or a
  // clear that emptied the list would take its own undo off screen with it.
  useEffect(() => {
    if (visible && tasks.length === 0 && !canUndo) {
      onClose();
    }
  }, [visible, tasks.length, canUndo, onClose]);

  const header = useMemo(
    () => ({
      title: t("agentTasks.drawerTitle"),
      actions:
        tasks.length > 0 ? (
          <View style={styles.drawerActions}>
            <Pressable
              onPress={clearFinished}
              disabled={!hasFinished}
              style={hasFinished ? drawerDismissFinishedStyle : drawerDismissFinishedDisabledStyle}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={
                hasFinished
                  ? t("agentTasksToast.dismissFinished", { count: finishedCount })
                  : t("agentTasksToast.dismissFinishedEmpty")
              }
              accessibilityState={hasFinished ? A11Y_ENABLED : A11Y_DISABLED}
              testID="agent-tasks-toast-drawer-dismiss-finished"
            >
              <Trash2 size={16} color={styles.drawerDismissAllIcon.color} />
              {hasFinished ? <Text style={styles.drawerDismissCount}>{finishedCount}</Text> : null}
            </Pressable>
            <ToastClearMenu counts={counts} onClear={clearCategory} compact />
          </View>
        ) : undefined,
    }),
    [t, tasks.length, hasFinished, finishedCount, counts, clearCategory, clearFinished],
  );

  // The sheet's own bottom safe-area padding doesn't render on the standalone
  // PWA (env() insets don't reach the portaled bottom sheet), so the drawer must
  // own its home-indicator clearance instead of trusting the sheet. Reserve the
  // real inset when we have it, but never less than the fallback floor — that
  // keeps the last card off the home indicator even when insets resolve to 0.
  const listStyle = useMemo(
    () => [
      styles.drawerList,
      { paddingBottom: Math.max(insets.bottom, DRAWER_BOTTOM_SAFE_AREA_FALLBACK) },
    ],
    [insets.bottom],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      dynamicSizing
      contentPaddingScale={DRAWER_CONTENT_PADDING_SCALE}
      testID="agent-tasks-toast-drawer"
    >
      <View style={listStyle}>
        {canUndo ? <ToastUndoPill count={undoCount} onUndo={undo} stretch /> : null}
        {tasks.length === 0 ? (
          <Text style={styles.emptyText}>{t("agentTasks.drawerEmpty")}</Text>
        ) : (
          tasks.map((task) => (
            <TaskToast key={task.key} task={task} onActivate={onClose} fullWidth />
          ))
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

// Module-level so the prop identity stays stable across renders.
const A11Y_ENABLED = { disabled: false } as const;
const A11Y_DISABLED = { disabled: true } as const;

const FAB_SIZE = 44;

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    right: theme.spacing[4],
    alignItems: "flex-end",
    zIndex: 1000,
  },
  fab: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    ...theme.shadow.md,
  },
  fabPressed: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.borderAccent,
  },
  count: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  drawerList: {
    gap: theme.spacing[2],
    // The status pip straddles the top-left corner of the first card (top: -5),
    // so give the list a little headroom or the badge gets clipped by the sheet.
    paddingTop: theme.spacing[2],
  },
  // Trash + category menu share the sheet header actions slot.
  drawerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  // Icon-only trash sitting in the sheet header actions slot.
  drawerDismissAll: {
    flexDirection: "row",
    minWidth: 30,
    height: 30,
    paddingHorizontal: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  drawerDismissCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  drawerDismissAllPressed: {
    backgroundColor: theme.colors.surface2,
  },
  drawerDismissAllDisabled: {
    opacity: 0.4,
  },
  drawerDismissAllIcon: {
    color: theme.colors.foregroundMuted,
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingVertical: theme.spacing[2],
  },
}));

function fabPressableStyle({ pressed }: { pressed: boolean }) {
  return [styles.fab, pressed && styles.fabPressed];
}

function drawerDismissFinishedStyle({ pressed }: { pressed: boolean }) {
  return [styles.drawerDismissAll, pressed && styles.drawerDismissAllPressed];
}

// Dimmed and inert while nothing in the drawer has finished.
const drawerDismissFinishedDisabledStyle = [
  styles.drawerDismissAll,
  styles.drawerDismissAllDisabled,
];

import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { TaskToast, useTrackedTasks } from "@/components/agent-tasks-toast-stack";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

// Matches theme.spacing[4]; kept a literal so the container can add the safe-area
// inset without subscribing the whole component to the theme runtime.
const BASE_BOTTOM_OFFSET = 16;
// Clear the message composer that lives along the bottom edge on the compact
// chat screen so the button floats above it instead of overlapping the input.
const COMPOSER_CLEARANCE = 140;
// Sit the list close to the sheet edges (spacing[4]) instead of the header's
// wide default indent (spacing[6]) so the cards read as full-width rows.
const DRAWER_CONTENT_PADDING_SCALE = 4;

// Compact-only counterpart to AgentTasksToastStack: a round badge in the
// bottom-right corner showing how many agent tasks are being tracked. Tapping it
// opens a drawer listing the same toasts the desktop stack renders inline.
export function AgentTasksToastFab(): ReactElement | null {
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const visible = useTrackedTasks();
  const [open, setOpen] = useState(false);

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);

  const containerStyle = useMemo(
    () => [
      styles.container,
      inlineUnistylesStyle({
        bottom: BASE_BOTTOM_OFFSET + COMPOSER_CLEARANCE + insets.bottom,
      }),
    ],
    [insets.bottom],
  );

  // Keep the drawer mounted while it animates closed even after the last toast
  // disappears, but don't render the button once there's nothing to show.
  if (!isCompact || (visible.length === 0 && !open)) {
    return null;
  }

  return (
    <>
      <View style={containerStyle} pointerEvents="box-none">
        <Pressable
          style={fabPressableStyle}
          onPress={handleOpen}
          accessibilityRole="button"
          accessibilityLabel={t("agentTasks.openDrawer", { count: visible.length })}
          testID="agent-tasks-toast-fab"
        >
          <Text style={styles.count}>{visible.length}</Text>
        </Pressable>
      </View>
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
  const header = useMemo(() => ({ title: t("agentTasks.drawerTitle") }), [t]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      dynamicSizing
      contentPaddingScale={DRAWER_CONTENT_PADDING_SCALE}
      testID="agent-tasks-toast-drawer"
    >
      <View style={styles.drawerList}>
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

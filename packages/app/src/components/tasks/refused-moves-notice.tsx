import { memo, useCallback, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  clearRefusedMoves,
  getRefusedMoves,
  subscribeToRefusedMoves,
} from "@/components/tasks/board-move-log";
import { useColumnLabels } from "@/components/tasks/kanban-columns";

/**
 * The board's record of gestures it refused.
 *
 * A refused move is a deliberate no-op: the card stays where it is and nothing
 * is said, because the gesture was never an available action. That is right for
 * one mis-drag and wrong for the third in a row — at which point the board looks
 * broken and the user has no way to know why. Collapsed to a single line ("2
 * déplacements refusés"), it explains itself on demand and disappears once
 * acknowledged.
 *
 * Renders nothing when nothing was refused, which is the normal state.
 */
export const RefusedMovesNotice = memo(function RefusedMovesNotice() {
  const { t } = useTranslation();
  const labels = useColumnLabels();
  const refused = useSyncExternalStore(subscribeToRefusedMoves, getRefusedMoves, getRefusedMoves);
  const [expanded, setExpanded] = useState(false);
  const handleToggle = useCallback(() => setExpanded((current) => !current), []);
  const handleClear = useCallback(() => {
    setExpanded(false);
    clearRefusedMoves();
  }, []);
  if (refused.length === 0) {
    return null;
  }
  return (
    <View style={styles.card} testID="tasks-refused-moves">
      <View style={styles.row}>
        <Pressable
          onPress={handleToggle}
          hitSlop={6}
          accessibilityRole="button"
          style={styles.summaryButton}
          testID="tasks-refused-moves-toggle"
        >
          <Text style={styles.summary}>
            {t("tasks.board.refusedMoves", { count: refused.length })}
          </Text>
        </Pressable>
        <Pressable
          onPress={handleClear}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.board.refusedMovesClear")}
          testID="tasks-refused-moves-clear"
        >
          <Text style={styles.action}>{t("tasks.board.refusedMovesClear")}</Text>
        </Pressable>
      </View>
      {expanded
        ? refused.map((entry) => (
            <Text key={`${entry.taskId}-${entry.at}`} style={styles.detail} numberOfLines={1}>
              {t("tasks.board.refusedMoveLine", {
                title: entry.title,
                from: labels[entry.from],
                to: labels[entry.to],
              })}
            </Text>
          ))
        : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  summaryButton: {
    flexShrink: 1,
  },
  summary: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  action: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

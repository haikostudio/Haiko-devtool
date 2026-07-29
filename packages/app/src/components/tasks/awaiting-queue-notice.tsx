import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { KanbanTask, TaskColumn } from "@/data/tasks";
import { countTasksAwaitingQueue } from "@/components/tasks/deploy-queue";

/**
 * The quiet line at the head of the "Terminé" column: how many finished cards are
 * resting there with nobody having queued them for publication, and a one-press
 * way to queue the lot.
 *
 * A finished card stops in "Terminé" and waits — the daemon no longer moves it on
 * by itself. That is the point (the work becomes visible instead of flying past),
 * but it also means the column silently accumulates: three cards ready to ship
 * and a board nobody looks at read the same. The count makes the waiting
 * explicit; the button spares the user from dragging them across one by one.
 *
 * Queueing is NOT publishing: the cards land in "À déployer" and wait there for
 * the column's own "Tout déployer". Nothing is built here.
 *
 * It renders nothing when the column is empty: a "0 waiting" line is noise.
 */
export const AwaitingQueueNotice = memo(function AwaitingQueueNotice({
  column,
  tasks,
  onQueueAll,
}: {
  column: TaskColumn;
  tasks: readonly KanbanTask[];
  /** Moves every waiting card into "À déployer" — absent on read-only boards. */
  onQueueAll?: ((taskIds: string[]) => void) | undefined;
}) {
  const { t } = useTranslation();
  const waiting = useMemo(
    () => tasks.filter((task) => task.column === "done" && !task.archivedAt),
    [tasks],
  );
  const count = countTasksAwaitingQueue(tasks);
  const handleQueueAll = useCallback(() => {
    onQueueAll?.(waiting.map((task) => task.id));
  }, [onQueueAll, waiting]);
  if (column !== "done" || count === 0) {
    return null;
  }
  return (
    <View style={styles.notice} testID="tasks-awaiting-queue">
      <Text style={styles.text}>{t("tasks.board.awaitingQueue", { count })}</Text>
      {onQueueAll ? (
        <Pressable
          onPress={handleQueueAll}
          style={queueAllStyle}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.board.queueAll")}
          testID="tasks-queue-all"
        >
          <Text style={styles.action}>{t("tasks.board.queueAll")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

function queueAllStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.actionButton, (hovered || pressed) && styles.actionButtonHovered];
}

const styles = StyleSheet.create((theme) => ({
  notice: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  text: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  actionButton: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  actionButtonHovered: {
    backgroundColor: theme.colors.surface1,
  },
  action: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.xs,
  },
}));

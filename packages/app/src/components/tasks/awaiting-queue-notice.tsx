import { memo, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { KanbanTask, TaskColumn } from "@/data/tasks";
import { countTasksAwaitingQueue } from "@/components/tasks/deploy-queue";

/**
 * The quiet line at the head of the "Terminé" column: how many finished cards are
 * resting there with nobody having queued them for publication.
 *
 * A finished card stops in "Terminé" and waits — the daemon no longer moves it on
 * by itself. That is the point (the work becomes visible instead of flying past),
 * but it also means the column silently accumulates: three cards ready to ship
 * and a board nobody looks at read the same. The count makes the waiting explicit
 * without adding another button — publishing stays the queue column's job.
 *
 * It renders nothing when the column is empty: a "0 waiting" line is noise.
 */
export const AwaitingQueueNotice = memo(function AwaitingQueueNotice({
  column,
  tasks,
}: {
  column: TaskColumn;
  tasks: readonly KanbanTask[];
}) {
  const { t } = useTranslation();
  const waiting = useMemo(() => countTasksAwaitingQueue(tasks), [tasks]);
  if (column !== "done" || waiting === 0) {
    return null;
  }
  return (
    <View style={styles.notice} testID="tasks-awaiting-queue">
      <Text style={styles.text}>{t("tasks.board.awaitingQueue", { count: waiting })}</Text>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  notice: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

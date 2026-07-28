import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CloudUpload } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { KanbanTask } from "@/data/tasks";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usesWideBoardGutter } from "@/components/tasks/task-gantt-layout";
import { countPendingPublish } from "@/components/tasks/pending-publish-count";

const ThemedCloudUpload = withUnistyles(CloudUpload);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * One glanceable line above the board: "3 cartes prêtes à publier, dont 1
 * nécessitant un redémarrage". It answers, without opening a single card, the
 * two questions the per-card pills only answer one at a time — how much is
 * waiting, and whether the engine will have to be restarted afterwards.
 *
 * Silent when nothing is pending, and it drops the restart clause when no card
 * needs one, so the line never adds noise to a board that is fully published.
 * Shares the board's gutter rule so it lines up with the columns and the
 * billable total (see usesWideBoardGutter).
 */
export function PendingPublishSummary({ tasks }: { tasks: KanbanTask[] }) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const counts = useMemo(() => countPendingPublish(tasks), [tasks]);

  if (counts.pending === 0) {
    return null;
  }
  const label =
    counts.needingRestart > 0
      ? t("tasks.board.pendingPublishWithRestart", {
          count: counts.pending,
          restart: counts.needingRestart,
        })
      : t("tasks.board.pendingPublish", { count: counts.pending });
  return (
    <View
      style={[styles.row, usesWideBoardGutter(isCompact) ? styles.rowWide : styles.rowTight]}
      testID="tasks-pending-publish-summary"
    >
      <ThemedCloudUpload size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      <Text style={counts.needingRestart > 0 ? styles.textWarning : styles.text}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
  },
  // Same gutters as the kanban board, the timeline and the billable total, so
  // the whole board header column shares one left edge.
  rowWide: {
    paddingHorizontal: theme.spacing[4],
  },
  rowTight: {
    paddingHorizontal: theme.spacing[3],
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  // A pending restart is the one case worth a color: it is a step the user
  // still owes the engine, not just a queue length.
  textWarning: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));

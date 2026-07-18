import { memo, useCallback, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { KanbanTask, TaskBoard } from "@/data/tasks";
import { deriveProjectIconColor } from "@/utils/project-icon-color";

// Columns the timeline projects. Backlog is the icebox (not planned) and done is
// history — the Gantt only surfaces what is actively planned or executing, in
// time order (executing now on the left, planned next on the right).
const GANTT_ORDER: Record<string, number> = { in_progress: 0, scheduled: 1 };

// Quota share (0-100) assigned to un-estimated tasks so their bar stays visible
// and the plan still reads as a sequence before every task has been estimated.
const FALLBACK_WEIGHT = 4;

interface GanttRow {
  task: KanbanTask;
  folderColor?: string;
  estimated: boolean;
  running: boolean;
  // Cumulative-quota placement, expressed as track percentages.
  leftPct: number;
  widthPct: number;
  quotaLabel: string | null;
}

interface TaskGanttProps {
  board: TaskBoard;
  onPressTask: (task: KanbanTask) => void;
}

// A compact projected timeline that sits above the kanban board. One bar per
// planned/running task across the whole project, chained left-to-right by
// cumulative quota so the bar length reads as "how much of a 5h window this
// task eats". Bars carry the project color so the strip ties back to the
// colored dot in the projects rail.
export const TaskGantt = memo(function TaskGantt({ board, onPressTask }: TaskGanttProps) {
  const { t } = useTranslation();
  const projectColor = deriveProjectIconColor(board.projectId);

  const { rows, totalQuota } = useMemo(() => {
    const folderColorById = new Map(board.folders.map((folder) => [folder.id, folder.color]));
    const planned = board.tasks
      .filter((task) => task.column === "in_progress" || task.column === "scheduled")
      .sort(
        (left, right) =>
          (GANTT_ORDER[left.column] ?? 9) - (GANTT_ORDER[right.column] ?? 9) ||
          left.order - right.order ||
          left.createdAt.localeCompare(right.createdAt),
      );

    const weights = planned.map((task) =>
      task.estimate ? Math.max(task.estimate.quotaPercent, 0.5) : FALLBACK_WEIGHT,
    );
    const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;

    let cumulative = 0;
    const built: GanttRow[] = planned.map((task, index) => {
      const weight = weights[index];
      const leftPct = (cumulative / total) * 100;
      const widthPct = (weight / total) * 100;
      cumulative += weight;
      return {
        task,
        folderColor: folderColorById.get(task.folderId),
        estimated: Boolean(task.estimate),
        running: task.column === "in_progress",
        leftPct,
        widthPct,
        quotaLabel: task.estimate
          ? t("tasks.card.quotaEstimate", { percent: Math.round(task.estimate.quotaPercent) })
          : null,
      };
    });

    // Cumulative sum of the real (estimated-only) quota, for the header summary.
    const realQuota = planned.reduce((sum, task) => sum + (task.estimate?.quotaPercent ?? 0), 0);
    return { rows: built, totalQuota: realQuota };
  }, [board.folders, board.tasks, t]);

  if (rows.length === 0) {
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{t("tasks.gantt.title")}</Text>
        {totalQuota > 0 ? (
          <Text style={styles.summary}>
            {t("tasks.card.quotaEstimate", { percent: Math.round(totalQuota) })}
          </Text>
        ) : null}
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {rows.map((row) => (
          <GanttRowView
            key={row.task.id}
            row={row}
            projectColor={projectColor}
            onPressTask={onPressTask}
          />
        ))}
      </ScrollView>
    </View>
  );
});

const GanttRowView = memo(function GanttRowView({
  row,
  projectColor,
  onPressTask,
}: {
  row: GanttRow;
  projectColor: string;
  onPressTask: (task: KanbanTask) => void;
}) {
  const handlePress = useCallback(() => {
    onPressTask(row.task);
  }, [onPressTask, row.task]);

  const barStyle = useMemo(() => {
    const base = {
      left: `${row.leftPct}%` as const,
      width: `${row.widthPct}%` as const,
    };
    if (!row.estimated) {
      // Un-estimated: outline only, so an unknown size reads differently from a
      // measured one without inventing a length.
      return [styles.bar, styles.barOutlined, base, { borderColor: projectColor }];
    }
    return [styles.bar, base, { backgroundColor: projectColor }, !row.running && styles.barPlanned];
  }, [row.estimated, row.running, row.leftPct, row.widthPct, projectColor]);

  const dotStyle = useMemo(
    () => (row.folderColor ? [styles.folderDot, { backgroundColor: row.folderColor }] : null),
    [row.folderColor],
  );

  return (
    <Pressable
      style={rowPressableStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={row.task.title}
      testID={`tasks-gantt-row-${row.task.id}`}
    >
      <View style={styles.labelCell}>
        {dotStyle ? <View style={dotStyle} /> : null}
        <Text style={styles.labelText} numberOfLines={1}>
          {row.task.title}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={barStyle} />
      </View>
      <Text style={styles.quotaText} numberOfLines={1}>
        {row.quotaLabel ?? "—"}
      </Text>
    </Pressable>
  );
});

function rowPressableStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.row, (hovered || pressed) && styles.rowHovered];
}

const BAR_HEIGHT = 14;

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    gap: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  scroll: {
    maxHeight: 168,
  },
  scrollContent: {
    gap: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  labelCell: {
    width: 128,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  folderDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  labelText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  track: {
    flex: 1,
    height: BAR_HEIGHT,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  bar: {
    position: "absolute",
    top: 0,
    bottom: 0,
    minWidth: 6,
    borderRadius: theme.borderRadius.full,
  },
  barPlanned: {
    opacity: 0.6,
  },
  barOutlined: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderStyle: "dashed",
    opacity: 0.85,
  },
  quotaText: {
    width: 52,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

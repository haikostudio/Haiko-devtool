import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { Bot, Clock, GitPullRequest } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { KanbanTask } from "@/data/tasks";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  daysUntil,
  parseTaskTags,
  type ParsedDeadline,
  type ParsedPriority,
} from "@/components/tasks/task-tags";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const warningColorMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const ThemedBot = withUnistyles(Bot);
const ThemedClock = withUnistyles(Clock);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);

interface TaskCardProps {
  task: KanbanTask;
  onPress: (task: KanbanTask) => void;
  testID?: string;
}

function cardStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.card, (hovered || pressed) && styles.cardHovered];
}

type ScheduleBadgeVariant = "success" | "error" | "warning";

interface ScheduleBadgeDescriptor {
  labelKey: string;
  variant?: ScheduleBadgeVariant;
}

// Pure schedule-state → badge mapping. Kept at module scope so its branch count
// stays out of the TaskCard render-function complexity budget.
function getScheduleBadge(task: KanbanTask): ScheduleBadgeDescriptor | null {
  if (task.approval?.state === "pending") {
    return { labelKey: "tasks.approval.pending", variant: "warning" };
  }
  if (task.planReadyAt) {
    return { labelKey: "tasks.card.planReady", variant: "success" };
  }
  const state = task.schedule?.state;
  if (!state) {
    return null;
  }
  if (state === "failed") {
    return { labelKey: "tasks.schedule.failed", variant: "error" };
  }
  if (state === "running" || state === "launching") {
    return { labelKey: "tasks.schedule.running", variant: "success" };
  }
  if (state === "pending_estimate") {
    return { labelKey: "tasks.schedule.estimating" };
  }
  if (task.schedule?.waitingReason === "quiet_hours") {
    return { labelKey: "tasks.schedule.awaitingWindow" };
  }
  return { labelKey: "tasks.schedule.awaiting" };
}

/**
 * A single kanban card: title, priority flag, deadline, quota estimate,
 * schedule state, linked-agent marker, PR link and thematic tag chips. Kept
 * intentionally flat/minimal to match the Paseo surfaces (surface2 card on
 * surface1 column).
 */
export const TaskCard = memo(function TaskCard({ task, onPress, testID }: TaskCardProps) {
  const { t } = useTranslation();

  const handlePress = useCallback(() => {
    onPress(task);
  }, [onPress, task]);

  const { priority, deadline, tags } = useMemo(() => parseTaskTags(task.tags), [task.tags]);
  const scheduleBadge = useMemo(() => getScheduleBadge(task), [task]);

  const modelLabel = task.runConfig ? (task.runConfig.model ?? task.runConfig.provider) : null;

  const hasMetaRow = Boolean(
    task.estimate || scheduleBadge || modelLabel || task.links.primaryAgentId || task.links.prUrl,
  );

  return (
    <Pressable
      onPress={handlePress}
      style={cardStyle}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={task.title}
    >
      <Text style={styles.title} numberOfLines={3}>
        {task.title}
      </Text>
      {priority ? <PriorityFlag priority={priority} /> : null}
      {deadline ? <DeadlineRow deadline={deadline} /> : null}
      {hasMetaRow ? (
        <View style={styles.metaRow}>
          {task.estimate ? (
            <Text style={styles.estimateText}>
              {t("tasks.card.quotaEstimate", {
                percent: Math.round(task.estimate.quotaPercent),
              })}
            </Text>
          ) : null}
          {task.estimate?.estimatedMinutes !== undefined ? (
            <Text style={styles.estimateText}>
              {t("tasks.card.duration", { minutes: task.estimate.estimatedMinutes })}
            </Text>
          ) : null}
          {modelLabel ? (
            <View style={styles.tagChip}>
              <Text style={styles.tagText}>{modelLabel}</Text>
            </View>
          ) : null}
          {scheduleBadge ? (
            <StatusBadge label={t(scheduleBadge.labelKey)} variant={scheduleBadge.variant} />
          ) : null}
          {task.links.primaryAgentId ? (
            <ThemedBot size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          ) : null}
          {task.links.prUrl ? <PrChip prUrl={task.links.prUrl} /> : null}
        </View>
      ) : null}
      {tags.length > 0 ? (
        <View style={styles.tagsRow}>
          {tags.map((tag) => (
            <View key={tag} style={styles.tagChip}>
              <Text style={styles.tagText}>{tag}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {task.schedule?.lastError ? (
        <Text style={styles.errorText} numberOfLines={2}>
          {task.schedule.lastError}
        </Text>
      ) : null}
    </Pressable>
  );
});

// Colored priority flag — just the level word ("haute"), no "priorité" prefix,
// tinted so high/medium/low read at a glance.
const PriorityFlag = memo(function PriorityFlag({ priority }: { priority: ParsedPriority }) {
  const pillStyle = useMemo(
    () => [
      styles.priorityPill,
      priority.level === "high" && styles.priorityPillHigh,
      priority.level === "medium" && styles.priorityPillMedium,
      priority.level === "low" && styles.priorityPillLow,
    ],
    [priority.level],
  );
  const textStyle = useMemo(
    () => [
      styles.priorityText,
      priority.level === "high" && styles.priorityTextHigh,
      priority.level === "medium" && styles.priorityTextMedium,
      priority.level === "low" && styles.priorityTextLow,
    ],
    [priority.level],
  );
  return (
    <View style={styles.priorityRow}>
      <View style={pillStyle}>
        <Text style={textStyle}>{priority.label}</Text>
      </View>
    </View>
  );
});

// Deadline line: clock icon + date + days remaining. Overdue reads danger, due
// soon reads warning, otherwise muted. A non-date deadline ("à définir") drops
// the day count.
const DeadlineRow = memo(function DeadlineRow({ deadline }: { deadline: ParsedDeadline }) {
  const { t } = useTranslation();
  const remaining = useMemo(() => {
    if (!deadline.dueDate) {
      return null;
    }
    return daysUntil(deadline.dueDate, new Date());
  }, [deadline.dueDate]);

  const overdue = remaining !== null && remaining < 0;
  const soon = remaining !== null && remaining >= 0 && remaining <= 2;
  let iconMapping = mutedColorMapping;
  if (overdue) {
    iconMapping = dangerColorMapping;
  } else if (soon) {
    iconMapping = warningColorMapping;
  }

  let daysLabel: string | null = null;
  if (remaining !== null) {
    if (remaining < 0) {
      daysLabel = t("tasks.card.deadlineOverdue");
    } else if (remaining === 0) {
      daysLabel = t("tasks.card.deadlineToday");
    } else {
      daysLabel = t("tasks.card.deadlineDays", { count: remaining });
    }
  }

  return (
    <View style={styles.deadlineRow}>
      <ThemedClock size={ICON_SIZE.sm} uniProps={iconMapping} />
      <Text style={styles.deadlineDate}>{deadline.label}</Text>
      {daysLabel ? (
        <Text style={overdue ? styles.deadlineDaysOverdue : styles.deadlineDays}>
          {`· ${daysLabel}`}
        </Text>
      ) : null}
    </View>
  );
});

const PrChip = memo(function PrChip({ prUrl }: { prUrl: string }) {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => {
    void openExternalUrl(prUrl);
  }, [prUrl]);
  return (
    <Pressable
      onPress={handleOpen}
      hitSlop={6}
      accessibilityRole="link"
      accessibilityLabel={t("tasks.card.openPr")}
      style={styles.prChip}
    >
      <ThemedGitPullRequest size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      <Text style={styles.prText}>{t("tasks.card.pr", { number: extractPrNumber(prUrl) })}</Text>
    </Pressable>
  );
});

function extractPrNumber(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match?.[1] ?? "?";
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  cardHovered: {
    backgroundColor: theme.colors.surface3,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  tagsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  priorityRow: {
    flexDirection: "row",
  },
  priorityPill: {
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  priorityPillHigh: {
    backgroundColor: theme.colors.palette.red[900],
    borderColor: theme.colors.palette.red[800],
  },
  priorityPillMedium: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.palette.amber[700],
  },
  priorityPillLow: {
    backgroundColor: theme.colors.palette.blue[900],
    borderColor: theme.colors.palette.blue[800],
  },
  priorityText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "capitalize",
    color: theme.colors.foregroundMuted,
  },
  priorityTextHigh: {
    color: theme.colors.palette.red[500],
  },
  priorityTextMedium: {
    color: theme.colors.statusWarning,
  },
  priorityTextLow: {
    color: theme.colors.palette.blue[400],
  },
  deadlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  deadlineDate: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  deadlineDays: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  deadlineDaysOverdue: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  tagChip: {
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  tagText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  estimateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  prChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  prText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
}));

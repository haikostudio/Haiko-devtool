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
 * A single kanban card, ticket-style: a soft tinted priority chip on top, the
 * title, an optional two-line description, then deadline / meta / tags. Flat
 * surfaces only — a surface0 card with a hairline border sitting on the
 * folder-tinted column, generous padding so the board breathes.
 */
export const TaskCard = memo(function TaskCard({ task, onPress, testID }: TaskCardProps) {
  const { t } = useTranslation();

  const handlePress = useCallback(() => {
    onPress(task);
  }, [onPress, task]);

  const { priority, deadline, tags } = useMemo(() => parseTaskTags(task.tags), [task.tags]);
  const scheduleBadge = useMemo(() => getScheduleBadge(task), [task]);

  const hasChipRow = Boolean(priority || scheduleBadge);

  return (
    <Pressable
      onPress={handlePress}
      style={cardStyle}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={task.title}
    >
      {hasChipRow ? (
        <View style={styles.chipRow}>
          {priority ? <PriorityChip priority={priority} /> : null}
          {scheduleBadge ? (
            <StatusBadge label={t(scheduleBadge.labelKey)} variant={scheduleBadge.variant} />
          ) : null}
        </View>
      ) : null}
      <Text style={styles.title} numberOfLines={3}>
        {task.title}
      </Text>
      {task.description ? (
        <Text style={styles.description} numberOfLines={2}>
          {task.description}
        </Text>
      ) : null}
      {deadline ? <DeadlineRow deadline={deadline} /> : null}
      <CardMetaRow task={task} />
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

// Muted single-line footer: quota share, duration, model, linked agent, PR.
// Split out of TaskCard to keep the card render under the complexity budget.
const CardMetaRow = memo(function CardMetaRow({ task }: { task: KanbanTask }) {
  const { t } = useTranslation();
  const modelLabel = task.runConfig ? (task.runConfig.model ?? task.runConfig.provider) : null;
  const hasMetaRow = Boolean(
    task.estimate || modelLabel || task.links.primaryAgentId || task.links.prUrl,
  );
  if (!hasMetaRow) {
    return null;
  }
  return (
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
      {modelLabel ? <Text style={styles.estimateText}>{modelLabel}</Text> : null}
      {task.links.primaryAgentId ? (
        <ThemedBot size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      ) : null}
      {task.links.prUrl ? <PrChip prUrl={task.links.prUrl} /> : null}
    </View>
  );
});

// Soft tinted priority chip — level word only ("Haute"), status-colored text on
// a 10%-alpha tint of the same color (docs/design.md §12). Low priority stays
// deliberately quiet: muted text on a neutral surface.
const PriorityChip = memo(function PriorityChip({ priority }: { priority: ParsedPriority }) {
  const pillStyle = useMemo(
    () => [
      styles.priorityChip,
      priority.level === "high" && styles.priorityChipHigh,
      priority.level === "medium" && styles.priorityChipMedium,
    ],
    [priority.level],
  );
  const textStyle = useMemo(
    () => [
      styles.priorityText,
      priority.level === "high" && styles.priorityTextHigh,
      priority.level === "medium" && styles.priorityTextMedium,
    ],
    [priority.level],
  );
  return (
    <View style={pillStyle}>
      <Text style={textStyle}>{priority.label}</Text>
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
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  cardHovered: {
    backgroundColor: theme.colors.surface1,
  },
  chipRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    // Clears the absolute move-to trigger the touch board overlays top-right.
    paddingRight: theme.spacing[6],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 17,
  },
  tagsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  priorityChip: {
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  priorityChipHigh: {
    backgroundColor: `${theme.colors.statusDanger}1A`,
  },
  priorityChipMedium: {
    backgroundColor: `${theme.colors.statusWarning}1A`,
  },
  priorityText: {
    fontSize: theme.fontSize.xs,
    textTransform: "capitalize",
    color: theme.colors.foregroundMuted,
  },
  priorityTextHigh: {
    color: theme.colors.statusDanger,
  },
  priorityTextMedium: {
    color: theme.colors.statusWarning,
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
  },
  tagChip: {
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
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

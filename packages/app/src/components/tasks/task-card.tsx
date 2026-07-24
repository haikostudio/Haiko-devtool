import { memo, useCallback, useEffect, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
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
import { useTaskQuietHours } from "@/components/tasks/task-schedule-context";
import { TaskStatusVoyant, useTaskTone } from "@/components/tasks/task-status-voyant";
import {
  isQuietTime,
  nextQuietHoursStartMs,
  waitsForOffPeak,
  type QuietHours,
} from "@/components/tasks/task-schedule";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const warningColorMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const ThemedBot = withUnistyles(Bot);
const ThemedClock = withUnistyles(Clock);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);

// The triage prefixes generated descriptions with a "Priorité : … — Date
// objectif : …" line that only restates the chip + deadline already on the card.
const BOILERPLATE_DESCRIPTION = /^\s*priorit[ée]\s*:/i;

// Tags past this cap collapse into a "+N" chip to keep the card compact.
const MAX_VISIBLE_TAGS = 3;

interface TaskCardProps {
  task: KanbanTask;
  onPress: (task: KanbanTask) => void;
  testID?: string;
}

// Notes carry their importance as a colored left accent so the column reads at a
// glance — red for high, amber for medium, a quiet hairline otherwise.
type NoteAccent = "high" | "medium" | "muted";

function cardStyle({
  pressed,
  hovered,
  dimmed,
  accent,
}: {
  pressed: boolean;
  hovered?: boolean;
  dimmed?: boolean;
  accent?: NoteAccent;
}) {
  return [
    styles.card,
    (hovered || pressed) && styles.cardHovered,
    dimmed && styles.cardDimmed,
    accent === "high" && styles.noteAccentHigh,
    accent === "medium" && styles.noteAccentMedium,
    accent === "muted" && styles.noteAccentMuted,
  ];
}

// The importance → accent mapping used only on note (draft) cards.
function noteAccentFor(level: ParsedPriority["level"] | undefined): NoteAccent {
  if (level === "high") {
    return "high";
  }
  if (level === "medium") {
    return "medium";
  }
  return "muted";
}

// A finished card the user has already opened recedes: dim it so unseen finished
// work (full opacity) still catches the eye. Only "done"/"deployed" cards ever
// dim — an in-flight card stays bright regardless of whether it's been opened.
function isCardDimmed(task: KanbanTask): boolean {
  return Boolean(task.viewedAt) && (task.column === "done" || task.column === "deployed");
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
  // "Pause au choix": analyzed but held until the user gives the go.
  if (task.executionHold === true) {
    return { labelKey: "tasks.schedule.heldForReview", variant: "warning" };
  }
  if (task.schedule?.waitingReason === "quiet_hours") {
    return { labelKey: "tasks.schedule.awaitingWindow" };
  }
  return { labelKey: "tasks.schedule.awaiting" };
}

// When a validated/planned task will actually launch: the scheduler holds
// heavy (or off-peak-preferring) tasks until the next quiet-hours window, so we
// surface that opening time as a concrete hint. Returns null for tasks that run
// on the next tick anyway (light "auto"/"asap"), already-running/failed tasks,
// or when the window is open right now (launch is imminent — the badge says so).
function computeNextRunAt(task: KanbanTask, quietHours: QuietHours, nowMs: number): number | null {
  if (task.column !== "validated" && task.column !== "scheduled") {
    return null;
  }
  if (!task.estimate || task.approval?.state === "pending") {
    return null;
  }
  const state = task.schedule?.state;
  if (state === "running" || state === "launching" || state === "failed") {
    return null;
  }
  if (!waitsForOffPeak(task) || isQuietTime(nowMs, quietHours)) {
    return null;
  }
  return nextQuietHoursStartMs(nowMs, quietHours);
}

// Horizontal travel (px) of the attention shake, and how often it repeats.
const SHAKE_AMPLITUDE = 3;
const SHAKE_INTERVAL_MS = 5000;

/**
 * Drives the "waiting for you" shake: a short burst of horizontal wobbles (~0.4s)
 * followed by a rest, looping every `SHAKE_INTERVAL_MS`. Returns an animated
 * transform style to spread on the card wrapper. Disabled (identity transform)
 * when the task isn't waiting, or when the OS asks for reduced motion.
 */
function useAttentionShake(active: boolean) {
  const offset = useSharedValue(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!active || reduceMotion) {
      cancelAnimation(offset);
      offset.value = withTiming(0, { duration: 120 });
      return;
    }
    // One burst: quick out-and-back wobbles that settle, then hold still for the
    // remainder of the interval before the repeat replays it.
    const burst = withSequence(
      withTiming(-1, { duration: 55 }),
      withTiming(1, { duration: 90 }),
      withTiming(-0.6, { duration: 90 }),
      withTiming(0.4, { duration: 80 }),
      withTiming(0, { duration: 70 }),
    );
    offset.value = withRepeat(withDelay(SHAKE_INTERVAL_MS - 385, burst), -1, false);
    return () => {
      cancelAnimation(offset);
      offset.value = 0;
    };
  }, [active, reduceMotion, offset]);

  return useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value * SHAKE_AMPLITUDE }],
  }));
}

/**
 * A single kanban card, ticket-style: a soft tinted priority chip on top, the
 * title, an optional two-line description, then deadline / meta / tags. Flat
 * surfaces only — a surface0 card with a hairline border sitting on the
 * folder-tinted column, generous padding so the board breathes.
 */
export const TaskCard = memo(function TaskCard({ task, onPress, testID }: TaskCardProps) {
  const { t, i18n } = useTranslation();
  const quietHours = useTaskQuietHours();

  const handlePress = useCallback(() => {
    onPress(task);
  }, [onPress, task]);

  const { priority, deadline, tags } = useMemo(() => parseTaskTags(task.tags), [task.tags]);
  const scheduleBadge = useMemo(() => getScheduleBadge(task), [task]);
  const tone = useTaskTone(task);

  const isNote = task.column === "notes";
  // A note whose deadline is here (overdue or within two days) nudges itself, the
  // same attention shake a task waiting for a reply uses — an in-app "the clock is
  // ticking" alert with no server/push involved.
  const noteDeadlineUrgent = useMemo(() => {
    if (!isNote || !deadline?.dueDate) {
      return false;
    }
    return daysUntil(deadline.dueDate, new Date()) <= 2;
  }, [isNote, deadline]);

  // A task that wants a reply nudges itself: a light horizontal shake every ~5s,
  // just enough to catch the eye without being noisy. Honors reduced motion.
  const shakeStyle = useAttentionShake(tone === "attention" || noteDeadlineUrgent);

  // Concrete "runs around 01:00" hint for tasks the scheduler parks until the
  // next off-peak window. Formatted in the window's timezone and the UI locale.
  const nextRunLabel = useMemo(() => {
    const nextRunAt = computeNextRunAt(task, quietHours, Date.now());
    if (nextRunAt === null) {
      return null;
    }
    const when = new Intl.DateTimeFormat(i18n.language, {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: quietHours.timeZone,
    }).format(new Date(nextRunAt));
    return t("tasks.schedule.nextRun", { when });
  }, [task, quietHours, i18n.language, t]);

  // The triage writes a "Priorité : … — Date objectif : …" boilerplate into the
  // description that just restates the priority dot and deadline row. Hide it so
  // only a genuine, human-written description ever shows on the card.
  const description = useMemo(() => {
    const text = task.description?.trim();
    return text && !BOILERPLATE_DESCRIPTION.test(text) ? text : null;
  }, [task.description]);

  const visibleTags = tags.slice(0, MAX_VISIBLE_TAGS);
  const hiddenTagCount = tags.length - visibleTags.length;

  const priorityLabel = priority?.label;
  const dimmed = isCardDimmed(task);
  const accent = isNote ? noteAccentFor(priority?.level) : undefined;
  const resolveCardStyle = useCallback(
    ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) =>
      cardStyle({ pressed, hovered, dimmed, accent }),
    [dimmed, accent],
  );

  return (
    <Animated.View style={shakeStyle}>
      <Pressable
        onPress={handlePress}
        style={resolveCardStyle}
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={priorityLabel ? `${priorityLabel} · ${task.title}` : task.title}
      >
        <TaskStatusVoyant tone={tone} variant="pip" />
        <View style={styles.titleRow}>
          {priority ? <PriorityDot level={priority.level} label={priorityLabel} /> : null}
          <Text style={styles.title} numberOfLines={3}>
            {task.title}
          </Text>
        </View>
        {scheduleBadge ? (
          <View style={styles.chipRow}>
            <StatusBadge label={t(scheduleBadge.labelKey)} variant={scheduleBadge.variant} />
          </View>
        ) : null}
        {nextRunLabel ? (
          <View style={styles.nextRunRow}>
            <ThemedClock size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
            <Text style={styles.nextRunText}>{nextRunLabel}</Text>
          </View>
        ) : null}
        {description ? (
          <Text style={styles.description} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
        <CardMetaRow task={task} deadline={deadline} />
        {visibleTags.length > 0 ? (
          <View style={styles.tagsRow}>
            {visibleTags.map((tag) => (
              <View key={tag} style={styles.tagChip}>
                <Text style={styles.tagText}>{tag}</Text>
              </View>
            ))}
            {hiddenTagCount > 0 ? (
              <View style={styles.tagChip}>
                <Text style={styles.tagText}>{`+${hiddenTagCount}`}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
        {task.schedule?.lastError ? (
          <Text style={styles.errorText} numberOfLines={2}>
            {task.schedule.lastError}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
});

// One muted footer line: deadline (colored) leads, then duration, then the
// linked-agent icon and PR chip. Quota share and model live in the task detail,
// not on the card — the card stays glanceable. Split out of TaskCard to keep the
// card render under the complexity budget.
const CardMetaRow = memo(function CardMetaRow({
  task,
  deadline,
}: {
  task: KanbanTask;
  deadline: ParsedDeadline | null;
}) {
  const { t } = useTranslation();
  const duration =
    task.estimate?.estimatedMinutes !== undefined
      ? t("tasks.card.duration", { minutes: task.estimate.estimatedMinutes })
      : null;

  const hasMetaRow = Boolean(deadline || duration || task.links.primaryAgentId || task.links.prUrl);
  if (!hasMetaRow) {
    return null;
  }
  return (
    <View style={styles.metaRow}>
      {deadline ? <DeadlineRow deadline={deadline} /> : null}
      {duration ? (
        <Text style={styles.estimateText}>{`${deadline ? "· " : ""}${duration}`}</Text>
      ) : null}
      {task.links.primaryAgentId ? (
        <ThemedBot size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      ) : null}
      {task.links.prUrl ? <PrChip prUrl={task.links.prUrl} /> : null}
    </View>
  );
});

// The priority "badge": a small colored dot the user reads at a glance — danger
// red for high, warning amber for medium, a quiet muted dot for low/other. The
// level word itself is dropped from the card; the color carries it (the a11y
// label still announces it).
const PriorityDot = memo(function PriorityDot({
  level,
  label,
}: {
  level: ParsedPriority["level"];
  label?: string;
}) {
  const dotStyle = useMemo(
    () => [
      styles.priorityDot,
      level === "high" && styles.priorityDotHigh,
      level === "medium" && styles.priorityDotMedium,
    ],
    [level],
  );
  return <View style={dotStyle} accessibilityLabel={label} />;
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
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[1.5],
  },
  cardHovered: {
    backgroundColor: theme.colors.surface1,
  },
  // Note (draft) cards: a colored left edge that carries the importance level.
  noteAccentHigh: {
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.statusDanger,
  },
  noteAccentMedium: {
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.statusWarning,
  },
  noteAccentMuted: {
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.foregroundMuted,
  },
  // Finished + already-seen: recede to half opacity so unseen finished work leads.
  cardDimmed: {
    opacity: 0.5,
  },
  chipRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    // Clears the absolute move-to trigger the touch board overlays top-right.
    paddingRight: theme.spacing[4],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    // Clears the absolute move-to trigger the touch board overlays top-right.
    paddingRight: theme.spacing[4],
  },
  title: {
    flex: 1,
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
  priorityDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
    // Nudge the dot down so it optically centers on the first line of the title.
    marginTop: theme.spacing[1.5],
  },
  priorityDotHigh: {
    backgroundColor: theme.colors.statusDanger,
  },
  priorityDotMedium: {
    backgroundColor: theme.colors.statusWarning,
  },
  deadlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  nextRunRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    // Clears the absolute move-to trigger the touch board overlays top-right.
    paddingRight: theme.spacing[4],
  },
  nextRunText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
    paddingVertical: theme.spacing[1],
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

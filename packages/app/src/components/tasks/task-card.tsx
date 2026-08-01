import { memo, useCallback, useEffect, useMemo, useState } from "react";
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
import { Bot, CircleHelp, Clock, GitPullRequest, Globe } from "lucide-react-native";
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
import { formatTokenCount, hasTaskUsage, totalTaskTokens } from "@/components/tasks/task-usage";
import { buildTaskGitJourney, type TaskGitStepId } from "@/components/tasks/task-git-journey";
import { TaskStatusVoyant, useTaskTone } from "@/components/tasks/task-status-voyant";
import { type TaskTone, shouldShowVoyant } from "@/components/tasks/task-status-tone";
import {
  getPublishNotice,
  getScheduleBadge,
  type ScheduleBadgeDescriptor,
} from "@/components/tasks/task-card-badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  isQuietTime,
  nextQuietHoursStartMs,
  waitsForOffPeak,
  type QuietHours,
} from "@/components/tasks/task-schedule";
import { useOpenTaskId } from "@/stores/tasks-board-ui-store";
import { Checkbox } from "@/components/ui/checkbox";
import type { CardSelection } from "@/components/tasks/archive-selection";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const warningColorMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const ThemedBot = withUnistyles(Bot);
const ThemedCircleHelp = withUnistyles(CircleHelp);
const ThemedClock = withUnistyles(Clock);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedGlobe = withUnistyles(Globe);

// The triage prefixes generated descriptions with a "Priorité : … — Date
// objectif : …" line that only restates the chip + deadline already on the card.
const BOILERPLATE_DESCRIPTION = /^\s*priorit[ée]\s*:/i;

// Tags past this cap collapse into a "+N" chip to keep the card compact.
const MAX_VISIBLE_TAGS = 3;

interface TaskCardProps {
  task: KanbanTask;
  onPress: (task: KanbanTask) => void;
  testID?: string;
  /**
   * Overrides the spoken label when the press does something other than open
   * the task — the lead card of a folded lot unfolds the pile instead.
   */
  accessibilityLabel?: string;
  /**
   * Bulk-archive selection slice. When `active`, the card grows a checkbox to the
   * left of its title and a press toggles the selection instead of opening the
   * task. Absent (the norm) leaves the card unchanged.
   */
  selection?: CardSelection;
}

// Cards carry no colored left edge: the user rejected that accent bar outright,
// so importance is signalled by the corner pip / inline dot only. Do not
// reintroduce a borderLeft here in a future restyle. The `attention` state below
// repaints the WHOLE hairline frame amber (never a left bar), the same way
// `selected` repaints it violet — a full ring, not an accent edge.
//
// Cards never fade: opacity stays at 100% in every state. The read/unread
// signal lives entirely in the corner pip (green while a finished card is
// unseen, gone once opened), NOT in the card's opacity. `selected` (the card
// open in the dock / Details drawer) repaints the frame violet; `attention`
// (the task is waiting on a reply) repaints it amber and wins over selected so
// a card the user is looking at still shouts that it needs an answer.
function cardStyle({
  pressed,
  hovered,
  selected,
  attention,
}: {
  pressed: boolean;
  hovered?: boolean;
  selected?: boolean;
  attention?: boolean;
}) {
  return [
    styles.card,
    (hovered || pressed) && styles.cardHovered,
    selected && styles.cardSelected,
    attention && styles.cardAttention,
  ];
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

// Horizontal travel (px) of the attention shake, and how often it repeats. Kept
// in step with the voyant's amber bounce (`BOUNCE_INTERVAL_MS`) so the frame,
// the corner light and the card all pulse together every 3s.
const SHAKE_AMPLITUDE = 3;
const SHAKE_INTERVAL_MS = 3000;

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
export const TaskCard = memo(function TaskCard({
  task,
  onPress,
  testID,
  accessibilityLabel,
  selection,
}: TaskCardProps) {
  const { t, i18n } = useTranslation();
  const quietHours = useTaskQuietHours();

  // In bulk-archive selection mode a press toggles the card's checkbox rather
  // than opening it; otherwise it opens the task as usual.
  const selectionActive = selection?.active ?? false;
  const handlePress = useCallback(() => {
    if (selection?.active) {
      selection.onToggle();
      return;
    }
    onPress(task);
  }, [selection, onPress, task]);

  const { priority, deadline, tags } = useMemo(() => parseTaskTags(task.tags), [task.tags]);
  const tone = useTaskTone(task);
  const scheduleBadge = useMemo(() => getScheduleBadge(task, tone), [task, tone]);
  const publishNotice = useMemo(() => getPublishNotice(task), [task]);

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

  // A task that wants a reply nudges itself: a light horizontal shake every 3s,
  // just enough to catch the eye without being noisy. Honors reduced motion. The
  // same `attention` tone also repaints the card's frame amber (see below), so a
  // waiting card reads at a glance even mid-drag or in a column other than "En
  // cours".
  const isAttention = tone === "attention";
  const shakeStyle = useAttentionShake(isAttention || noteDeadlineUrgent);

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
  // The card never fades — full opacity in every state. Only the corner pip
  // carries the read/unread signal: a finished card shows its green light until
  // opened (viewedAt), then drops it while staying at 100% opacity. A running
  // loader or amber "waiting for you" light always shows, so an agent that
  // comes back to life re-lights the card's live badge even after it was read.
  const showVoyant = shouldShowVoyant(task, tone);
  // The card the user currently has open (dock chat or Details drawer) wears a
  // thin violet outline so the board says which card the panel belongs to.
  const selected = useOpenTaskId() === task.id;
  const resolveCardStyle = useCallback(
    ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) =>
      cardStyle({ pressed, hovered, selected, attention: isAttention }),
    [selected, isAttention],
  );
  // Selection mode repaints the press as a checkbox toggle, so the card
  // announces itself as a checkbox with its checked state rather than a button.
  const selectionA11y = useMemo(
    () =>
      selectionActive
        ? { role: "checkbox" as const, state: { checked: selection?.checked ?? false } }
        : { role: "button" as const, state: undefined },
    [selectionActive, selection?.checked],
  );

  return (
    <Animated.View style={shakeStyle}>
      <Pressable
        onPress={handlePress}
        style={resolveCardStyle}
        testID={testID}
        accessibilityRole={selectionA11y.role}
        accessibilityState={selectionA11y.state}
        accessibilityLabel={
          accessibilityLabel ?? (priorityLabel ? `${priorityLabel} · ${task.title}` : task.title)
        }
      >
        <CardCornerPip
          isNote={isNote}
          showVoyant={showVoyant}
          tone={tone}
          level={priority?.level}
          label={priorityLabel}
        />
        {/* Content wrapper carries the overflow clip so long branch names / tags
            get truncated, while the corner pip above stays a direct child of the
            card and is free to straddle the border without being clipped. */}
        <View style={styles.cardContent}>
          <CardTitleRow
            title={task.title}
            priority={priority}
            isNote={isNote}
            priorityLabel={priorityLabel}
            selection={selection}
          />
          <CardStatusRow
            badge={scheduleBadge}
            publishNotice={publishNotice}
            errorReason={
              task.analysis?.state === "failed" && task.analysis.reason && !task.estimate
                ? task.analysis.reason
                : null
            }
          />
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
                  <Text style={styles.tagText} numberOfLines={1}>
                    {tag}
                  </Text>
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
        </View>
      </Pressable>
    </Animated.View>
  );
});

// The title line: an optional bulk-archive checkbox, then the priority dot, then
// the title itself. Split out of TaskCard so the selection branch lives here and
// the card render stays under the complexity budget.
const CardTitleRow = memo(function CardTitleRow({
  title,
  priority,
  isNote,
  priorityLabel,
  selection,
}: {
  title: string;
  priority: ParsedPriority | null;
  isNote: boolean;
  priorityLabel?: string;
  selection?: CardSelection;
}) {
  return (
    <View style={styles.titleRow}>
      {selection?.active ? (
        <View style={styles.selectionCheckbox}>
          <Checkbox checked={selection.checked} />
        </View>
      ) : null}
      {priority && !isNote ? <PriorityDot level={priority.level} label={priorityLabel} /> : null}
      <Text style={styles.title} numberOfLines={3}>
        {title}
      </Text>
    </View>
  );
});

/**
 * The card's status pills, all in the same tinted-frame family so they read as
 * one row of statuses rather than a badge plus some decoration.
 *
 * Two slots, in order: the live status ("Publication en cours", "Contrôle final
 * en cours", "Déployé"…) and, beside it, the amber "Redémarrage requis" advance
 * warning carried by a finished card whose publication won't take effect until
 * the daemon is restarted. They coexist deliberately: a card can be publishing
 * AND still need a restart afterwards. Split out of TaskCard to keep the card
 * render under the complexity budget.
 */
const CardStatusRow = memo(function CardStatusRow({
  badge,
  publishNotice,
  errorReason,
}: {
  badge: ScheduleBadgeDescriptor | null;
  publishNotice: ScheduleBadgeDescriptor | null;
  errorReason: string | null;
}) {
  const { t } = useTranslation();
  if (!badge && !publishNotice && !errorReason) {
    return null;
  }
  return (
    <View style={styles.chipRow}>
      {badge ? <StatusBadge label={t(badge.labelKey)} variant={badge.variant} /> : null}
      {publishNotice ? (
        <StatusBadge label={t(publishNotice.labelKey)} variant={publishNotice.variant} />
      ) : null}
      {errorReason ? <AnalysisReasonHint reason={errorReason} /> : null}
    </View>
  );
});

/**
 * The "?" beside an error badge. The card stays clean — no red wall of text —
 * and the full failure reason lives one tap away in a popover that reads in both
 * light and dark themes and dismisses on outside tap or a second tap. Only tasks
 * carrying a reason (failed analysis) render it; healthy statuses stay bare.
 */
const AnalysisReasonHint = memo(function AnalysisReasonHint({ reason }: { reason: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        style={styles.reasonTrigger}
        testID="task-card-error-reason"
        accessibilityRole="button"
        accessibilityLabel={t("tasks.analysis.reasonHint")}
      >
        <ThemedCircleHelp size={ICON_SIZE.sm} uniProps={dangerColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" offset={6} maxWidth={280}>
        <DropdownMenuHint style={styles.reasonHint}>
          {t("tasks.analysis.reason", { reason })}
        </DropdownMenuHint>
      </DropdownMenuContent>
    </DropdownMenu>
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

  const hasUsage = hasTaskUsage(task.usage);

  // A step that failed on THIS card (a merge conflict, a publication that broke).
  // Surfaced on the card front because it is the one thing the column cannot
  // show: four siblings shipping and one stuck look identical from the outside.
  const failedStep = findFailedGitStep(task);

  const hasMetaRow = Boolean(
    deadline ||
    duration ||
    hasUsage ||
    failedStep ||
    task.links.primaryAgentId ||
    task.links.prUrl ||
    task.deployedUrl ||
    task.deployedSha,
  );
  if (!hasMetaRow) {
    return null;
  }
  return (
    <View style={styles.metaRow}>
      {deadline ? <DeadlineRow deadline={deadline} /> : null}
      {duration ? (
        <Text style={styles.estimateText}>{`${deadline ? "· " : ""}${duration}`}</Text>
      ) : null}
      <UsageChip usage={task.usage} lead={Boolean(deadline || duration)} />
      {task.links.primaryAgentId ? (
        <ThemedBot size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      ) : null}
      {failedStep ? <GitFailureChip step={failedStep} /> : null}
      {task.links.prUrl ? <PrChip prUrl={task.links.prUrl} /> : null}
      {task.deployedUrl ? <LiveChip url={task.deployedUrl} /> : null}
      {/* The build this card's work actually went online in. "Déployé" alone
          stops answering "which version?" the moment a second publication
          follows, which is how doubt creeps back in. */}
      {task.deployedSha ? <VersionChip sha={task.deployedSha} /> : null}
    </View>
  );
});

/**
 * The light straddling a card's top-left corner. Two different meanings by
 * column, deliberately:
 *   - Notes are drafts, not runs. Their corner carries the *importance* level
 *     (red / amber / muted) — a note briefly flagged `refinement: "pending"`
 *     used to spin a "working" loader there, which read as progress on a card
 *     that isn't progressing. Every note gets a pip, muted when no priority tag
 *     was authored, so the column keeps one consistent anchor.
 *   - Every other column keeps the live status voyant (loader / amber / blue /
 *     green), which is what actually matters once a task is in flight.
 */
const CardCornerPip = memo(function CardCornerPip({
  isNote,
  showVoyant,
  tone,
  level,
  label,
}: {
  isNote: boolean;
  showVoyant: boolean;
  tone: TaskTone | null;
  level: ParsedPriority["level"] | undefined;
  label?: string;
}) {
  if (isNote) {
    return <PriorityPip level={level} label={label} />;
  }
  if (!showVoyant) {
    return null;
  }
  return <TaskStatusVoyant tone={tone} variant="pip" />;
});

// Importance as a corner pip, geometrically identical to the status voyant's pip
// so notes and tasks anchor their light in exactly the same spot.
const PriorityPip = memo(function PriorityPip({
  level,
  label,
}: {
  level: ParsedPriority["level"] | undefined;
  label?: string;
}) {
  const pipStyle = useMemo(
    () => [
      styles.priorityPip,
      level === "high" && styles.priorityPipHigh,
      level === "medium" && styles.priorityPipMedium,
    ],
    [level],
  );
  return <View style={pipStyle} accessibilityLabel={label} />;
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

/**
 * "En ligne" chip on a finished card: one tap to the address the work actually
 * went live at. Stamped by the daemon when the card reached "Terminée", so it
 * only ever appears on work that really shipped.
 */
const LiveChip = memo(function LiveChip({ url }: { url: string }) {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => {
    void openExternalUrl(url);
  }, [url]);
  return (
    <Pressable
      onPress={handleOpen}
      hitSlop={6}
      accessibilityRole="link"
      accessibilityLabel={t("tasks.card.openLive")}
      style={styles.prChip}
    >
      <ThemedGlobe size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      <Text style={styles.prText}>{t("tasks.card.live")}</Text>
    </Pressable>
  );
});

/**
 * The exact version a published card went online in, shown short (8 characters,
 * the length everything else in this repo quotes a commit at). Read-only: it is
 * a receipt, not a link — there is nothing useful to open from a phone.
 */
/**
 * Ce que la carte a réellement coûté, en un chiffre rond. C'est la seule réponse
 * chiffrée à « ce réglage économise-t-il vraiment ? ». Le détail (entrée /
 * sortie / tours) reste dans la fiche : la carte doit se lire d'un coup d'œil.
 */
const UsageChip = memo(function UsageChip({
  usage,
  lead,
}: {
  usage: KanbanTask["usage"];
  lead: boolean;
}) {
  const { t } = useTranslation();
  if (!hasTaskUsage(usage)) {
    return null;
  }
  const label = t("tasks.card.usage", { tokens: formatTokenCount(totalTaskTokens(usage)) });
  return (
    <Text style={styles.estimateText} testID="task-card-usage">
      {`${lead ? "· " : ""}${label}`}
    </Text>
  );
});

const VersionChip = memo(function VersionChip({ sha }: { sha: string }) {
  return (
    <View style={styles.prChip}>
      <Text style={styles.prText}>{sha.slice(0, 8)}</Text>
    </View>
  );
});

/**
 * The card's own bad news, in one word: "Fusion" or "Publication" in red. The
 * detail panel carries the reason; the card only has to stop the failure from
 * hiding behind a batch that otherwise went fine.
 */
const GitFailureChip = memo(function GitFailureChip({ step }: { step: TaskGitStepId }) {
  const { t } = useTranslation();
  return (
    <View style={styles.gitFailureChip}>
      <Text style={styles.gitFailureText}>{t(`tasks.git.steps.${step}`)}</Text>
    </View>
  );
});

/** The first step this card failed at, in journey order, or null when all is well. */
function findFailedGitStep(task: KanbanTask): TaskGitStepId | null {
  return buildTaskGitJourney(task).find((step) => step.state === "failed")?.id ?? null;
}

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
    // Pin the card to its column width: an unbreakable branch name or technical
    // tag must be clipped, never widen the card and open a horizontal scroll.
    // `minWidth: 0` lets the card shrink inside the flex column (react-native-web
    // defaults flex items to `minWidth: auto`). The clip itself now lives on
    // `cardContent`, NOT here — the card must stay unclipped so the corner pip,
    // which straddles the top-left border on purpose, is not rogné.
    minWidth: 0,
  },
  // Wraps everything except the corner pip. This is where the overflow clip
  // lives: long content is truncated inside the card, while the pip (a sibling
  // of this wrapper) can still overhang the card's edge and stay fully visible.
  cardContent: {
    gap: theme.spacing[1.5],
    minWidth: 0,
    overflow: "hidden",
  },
  cardHovered: {
    backgroundColor: theme.colors.surface1,
  },
  // The open card: same 1px frame, repainted violet. No fill, no shadow, no size
  // change — nothing that would shift the layout or fight the corner voyant.
  // `statusMerged` is the theme's violet in both light and dark.
  cardSelected: {
    borderColor: theme.colors.statusMerged,
  },
  // Waiting on the user: same 1px frame, repainted amber — a full ring, never a
  // left bar. Matches the corner voyant's amber light (`palette.amber[500]`, an
  // amber that reads in both light and dark), so frame, pip and shake all say
  // the same thing. Applied after `cardSelected` so it wins when a waiting card
  // also happens to be the one open in the dock.
  cardAttention: {
    borderColor: theme.colors.palette.amber[500],
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
  // Nudge the bulk-archive checkbox down so it optically centers on the first
  // line of the title, the same way the priority dot is offset.
  selectionCheckbox: {
    marginTop: 2,
  },
  title: {
    flex: 1,
    // Without this the flex text can grow to its unbreakable content on web and
    // push the card wider than the column; `minWidth: 0` lets it clamp instead.
    minWidth: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 17,
  },
  // The small "?" that sits beside an error badge. Kept compact so the row still
  // reads as one line of status; tapping it opens the full reason in a popover.
  reasonTrigger: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  // The failure reason inside the popover — muted popover text, wraps freely.
  reasonHint: {
    paddingVertical: theme.spacing[1],
  },
  tagsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    // Let the row shrink so a wrapped chip can't push past the card edge.
    minWidth: 0,
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
  // Mirrors the status voyant's `pip`: same size, offsets, ring and stacking, so
  // a note's importance light lands exactly where a task's status light would.
  priorityPip: {
    position: "absolute",
    top: -5,
    left: -5,
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: theme.colors.surface0,
    backgroundColor: theme.colors.foregroundMuted,
    zIndex: 2,
  },
  priorityPipHigh: {
    backgroundColor: theme.colors.statusDanger,
  },
  priorityPipMedium: {
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
    // A single technical tag (branch name, "paseo:deploy-branch:task/…") must be
    // capped to the card width and clipped, never stretch the card sideways.
    maxWidth: "100%",
    flexShrink: 1,
    overflow: "hidden",
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
  gitFailureChip: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: `${theme.colors.statusDanger}1A`,
    borderWidth: 1,
    borderColor: `${theme.colors.statusDanger}66`,
    paddingHorizontal: theme.spacing[2],
  },
  gitFailureText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
}));

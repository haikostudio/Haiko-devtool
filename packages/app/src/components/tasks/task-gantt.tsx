import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, type LayoutChangeEvent, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { KanbanTask, TaskBoard } from "@/data/tasks";
import { SPACING } from "@/styles/theme";
import {
  AXIS_HEIGHT,
  MAX_VISIBLE_ROWS,
  ROW_GAP,
  ROW_HEIGHT,
  ROW_TRACK_HEIGHT,
  ROW_VERTICAL_PADDING,
  rowsAreaHeight,
  usesWideBoardGutter,
} from "./task-gantt-layout";

// The timeline is scoped to committed work only: what's running now, then what
// is planned to launch next. Backlog / validated / done never appear — the
// strip answers "what is scheduled to happen", not "everything on the board".
// Running sorts before planned; any other column is filtered out upstream.
const GANTT_COLUMNS = new Set<KanbanTask["column"]>(["in_progress", "scheduled"]);
const GANTT_ORDER: Record<string, number> = {
  in_progress: 0,
  scheduled: 1,
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
// The Claude usage-quota window the scheduler packs against.
const QUOTA_WINDOW_MS = 5 * HOUR_MS;
// Projected duration for tasks that have no estimate yet — enough to give the
// bar a visible body without inventing precision (the bar is drawn dashed).
const FALLBACK_MINUTES = 30;
// Axis bounds: never narrower than 2h (bars stay readable), never wider than
// 12h (a deep backlog must not crush the near future into invisibility).
const MIN_HORIZON_MS = 2 * HOUR_MS;
const MAX_HORIZON_MS = 12 * HOUR_MS;

// Fixed column widths so the "now"/quota vertical lines can be positioned in
// plain px against the measured track. Row layout: label | track | start time.
const LABEL_WIDTH_DESKTOP = 200;
const LABEL_WIDTH_COMPACT = 112;
const START_WIDTH = 56;
const CELL_GAP = SPACING[2];

// Axis-label collision budget (px), applied against the measured track width so
// the hour ticks never pile onto the "now"/quota labels or each other on narrow
// screens. Labels are left-aligned at their position; each reserves this width.
const NOW_LABEL_RESERVE = 74;
const TICK_LABEL_WIDTH = 40;
const QUOTA_LABEL_WIDTH = 62;
const AXIS_LABEL_GAP = 10;

interface TimelineRow {
  task: KanbanTask;
  estimated: boolean;
  column: KanbanTask["column"];
  // Track placement as percentages of the visible horizon.
  leftPct: number;
  widthPct: number;
  // Right-cell label: projected launch time, "running", or an overflow hint.
  startLabel: string;
  startsBeyondHorizon: boolean;
}

interface AxisTick {
  leftPct: number;
  label: string;
}

interface TaskGanttProps {
  board: TaskBoard;
  onPressTask: (task: KanbanTask) => void;
  // When true the panel expands to fill its parent (its own tab on compact)
  // instead of sizing itself from its rows above the board.
  fill?: boolean;
}

function taskDurationMs(task: KanbanTask): number {
  if (task.estimate?.estimatedMinutes !== undefined) {
    return Math.max(task.estimate.estimatedMinutes, 5) * MINUTE_MS;
  }
  if (task.estimate) {
    // quotaPercent is the share of a 5h window — convert back to minutes.
    return Math.max((task.estimate.quotaPercent / 100) * QUOTA_WINDOW_MS, 5 * MINUTE_MS);
  }
  return FALLBACK_MINUTES * MINUTE_MS;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / MINUTE_MS);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) {
    return `~${minutes} min`;
  }
  if (minutes === 0) {
    return `~${hours} h`;
  }
  return `~${hours} h ${String(minutes).padStart(2, "0")}`;
}

/**
 * Projected timeline for the committed work only: a real time axis starting
 * now, one row per running or planned task (backlog/validated/done never show).
 * Running tasks start at the "now" line; planned tasks pack sequentially behind
 * them, so the strip answers "what launches when". Bars carry their kanban
 * column color — amber for "En cours", blue for "Planifié" — and a dashed amber
 * line marks the end of the 5h quota window. Re-renders every minute so the axis
 * actually tracks the passing time.
 */
export const TaskGantt = memo(function TaskGantt({
  board,
  onPressTask,
  fill = false,
}: TaskGanttProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();

  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, MINUTE_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const timeFormatter = useMemo(
    () => new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }),
    [],
  );

  const { rows, ticks, quotaPct, totalQuota, totalDurationMs } = useMemo(() => {
    const open = board.tasks
      .filter((task) => GANTT_COLUMNS.has(task.column))
      .sort(
        (left, right) =>
          (GANTT_ORDER[left.column] ?? 9) - (GANTT_ORDER[right.column] ?? 9) ||
          left.order - right.order ||
          left.createdAt.localeCompare(right.createdAt),
      );

    // Sequential packing: running tasks all start now; queued work starts once
    // the longest running task is projected to finish, then chains task after
    // task. A deliberate simplification of the scheduler (which packs by quota
    // budget), but it gives every task an honest "not before" launch slot.
    let runningEnd = 0;
    const spans: { start: number; end: number }[] = [];
    for (const task of open) {
      if (task.column !== "in_progress") {
        continue;
      }
      const end = taskDurationMs(task);
      runningEnd = Math.max(runningEnd, end);
    }
    let cursor = runningEnd;
    let maxEnd = runningEnd;
    for (const task of open) {
      const duration = taskDurationMs(task);
      if (task.column === "in_progress") {
        spans.push({ start: 0, end: duration });
        continue;
      }
      spans.push({ start: cursor, end: cursor + duration });
      cursor += duration;
      maxEnd = Math.max(maxEnd, cursor);
    }

    const horizonMs = Math.min(
      Math.max(Math.ceil(maxEnd / HOUR_MS) * HOUR_MS, MIN_HORIZON_MS),
      MAX_HORIZON_MS,
    );

    const builtRows: TimelineRow[] = open.map((task, index) => {
      const span = spans[index];
      const beyond = span.start >= horizonMs;
      const clampedStart = Math.min(span.start, horizonMs);
      const clampedEnd = Math.min(span.end, horizonMs);
      let startLabel: string;
      if (task.column === "in_progress") {
        startLabel = t("tasks.gantt.inProgress");
      } else if (beyond) {
        startLabel = `+${Math.round(span.start / HOUR_MS)} h`;
      } else {
        startLabel = timeFormatter.format(new Date(nowMs + span.start));
      }
      return {
        task,
        estimated: Boolean(task.estimate),
        column: task.column,
        leftPct: beyond ? 97 : (clampedStart / horizonMs) * 100,
        widthPct: beyond ? 3 : Math.max(((clampedEnd - clampedStart) / horizonMs) * 100, 1),
        startLabel,
        startsBeyondHorizon: beyond,
      };
    });

    // Hour ticks along the axis; denser when the horizon is short.
    let stepMs = HOUR_MS;
    if (horizonMs <= 3 * HOUR_MS) {
      stepMs = 30 * MINUTE_MS;
    } else if (horizonMs > 8 * HOUR_MS) {
      stepMs = 2 * HOUR_MS;
    }
    const builtTicks: AxisTick[] = [];
    for (let at = stepMs; at <= horizonMs - stepMs / 2; at += stepMs) {
      builtTicks.push({
        leftPct: (at / horizonMs) * 100,
        label: timeFormatter.format(new Date(nowMs + at)),
      });
    }

    const realQuota = open.reduce((sum, task) => sum + (task.estimate?.quotaPercent ?? 0), 0);
    const duration = open.reduce((sum, task) => sum + taskDurationMs(task), 0);

    return {
      rows: builtRows,
      ticks: builtTicks,
      quotaPct: QUOTA_WINDOW_MS < horizonMs ? (QUOTA_WINDOW_MS / horizonMs) * 100 : null,
      totalQuota: realQuota,
      totalDurationMs: duration,
    };
  }, [board.tasks, nowMs, t, timeFormatter]);

  // Measured width of the track cell, so the full-height vertical lines (now,
  // quota window) can be placed in px across the whole rows block.
  const [trackWidth, setTrackWidth] = useState(0);
  const handleTrackLayout = useCallback((event: LayoutChangeEvent) => {
    setTrackWidth(event.nativeEvent.layout.width);
  }, []);

  const labelWidth = isCompact ? LABEL_WIDTH_COMPACT : LABEL_WIDTH_DESKTOP;
  const trackLeft = labelWidth + CELL_GAP;
  const quotaPx = quotaPct !== null && trackWidth > 0 ? (trackWidth * quotaPct) / 100 : null;

  // Left-to-right sweep that drops any hour tick that would collide with the
  // "now" label, the quota label, the right edge, or the previous kept tick.
  // Naturally thins to one or two ticks on a narrow phone track, more on desktop.
  const visibleTicks = useMemo(() => {
    if (trackWidth <= 0) {
      return [] as { key: string; px: number; label: string }[];
    }
    const kept: { key: string; px: number; label: string }[] = [];
    let occupiedRight = NOW_LABEL_RESERVE;
    for (const tick of ticks) {
      const px = (trackWidth * tick.leftPct) / 100;
      if (px < occupiedRight + AXIS_LABEL_GAP) {
        continue;
      }
      if (px + TICK_LABEL_WIDTH > trackWidth) {
        continue;
      }
      if (
        quotaPx !== null &&
        px + TICK_LABEL_WIDTH + AXIS_LABEL_GAP > quotaPx &&
        px < quotaPx + QUOTA_LABEL_WIDTH + AXIS_LABEL_GAP
      ) {
        continue;
      }
      kept.push({ key: tick.label, px, label: tick.label });
      occupiedRight = px + TICK_LABEL_WIDTH;
    }
    return kept;
  }, [ticks, trackWidth, quotaPx]);

  const nowLineStyle = useMemo(() => [styles.nowLine, { left: trackLeft }], [trackLeft]);
  const labelSpacerStyle = useMemo(() => ({ width: labelWidth }), [labelWidth]);
  const quotaLineStyle = useMemo(
    () => (quotaPx === null ? null : [styles.quotaLine, { left: trackLeft + quotaPx }]),
    [quotaPx, trackLeft],
  );

  const rootStyle = useMemo(
    () => [
      styles.container,
      usesWideBoardGutter(isCompact) ? styles.containerWideGutter : styles.containerTightGutter,
      fill && styles.containerFill,
    ],
    [fill, isCompact],
  );
  const bodyStyle = useMemo(() => [styles.timelineBody, fill && styles.timelineBodyFill], [fill]);
  // Content-derived height: the panel is exactly as tall as the rows it shows.
  // In `fill` mode (its own compact tab) it takes the whole area instead.
  const rowsStyle = useMemo(
    () => (fill ? styles.rowsScrollFill : { height: rowsAreaHeight(rows.length) }),
    [fill, rows.length],
  );

  // No rows, no summary: an empty schedule has no cost to announce.
  let summary: string | null = null;
  if (rows.length > 0) {
    summary =
      totalQuota > 0
        ? `${t("tasks.card.quotaEstimate", { percent: Math.round(totalQuota) })} · ${formatDuration(totalDurationMs)}`
        : formatDuration(totalDurationMs);
  }

  return (
    <View style={rootStyle}>
      <View style={styles.header}>
        <Text style={styles.title}>{t("tasks.gantt.title")}</Text>
        {summary ? <Text style={styles.summary}>{summary}</Text> : null}
      </View>
      <View style={bodyStyle}>
        <View style={styles.axisRow}>
          <View style={labelSpacerStyle} />
          <View style={styles.axisTrack} onLayout={handleTrackLayout}>
            <Text style={styles.axisNowLabel}>{t("tasks.gantt.now")}</Text>
            {visibleTicks.map((tick) => (
              <AxisTickView key={tick.key} px={tick.px} label={tick.label} />
            ))}
            {quotaPx !== null ? (
              <AxisTickView px={quotaPx} label={t("tasks.gantt.quotaWindow")} quota />
            ) : null}
          </View>
          <View style={startSpacerStyle} />
        </View>
        <ScrollView
          style={rowsStyle}
          contentContainerStyle={rowsContentStyle}
          showsVerticalScrollIndicator={false}
          scrollEnabled={rows.length > MAX_VISIBLE_ROWS || fill}
        >
          {rows.length === 0 ? (
            <EmptyTimelineRow labelWidth={labelWidth} label={t("tasks.gantt.empty")} />
          ) : (
            rows.map((row) => (
              <TimelineRowView
                key={row.task.id}
                row={row}
                labelWidth={labelWidth}
                onPressTask={onPressTask}
              />
            ))
          )}
        </ScrollView>
        <View pointerEvents="none" style={nowLineStyle} />
        {quotaLineStyle ? <View pointerEvents="none" style={quotaLineStyle} /> : null}
      </View>
    </View>
  );
});

const startSpacerStyle = { width: START_WIDTH };

// Plain object, not a Unistyles style: styles created by StyleSheet.create are
// dropped when passed to contentContainerStyle on web (docs/unistyles.md), and
// this gap has to hold — the panel height is computed from it.
const rowsContentStyle = { gap: ROW_GAP };

const AxisTickView = memo(function AxisTickView({
  px,
  label,
  quota,
}: {
  px: number;
  label: string;
  quota?: boolean;
}) {
  const wrapStyle = useMemo(() => [styles.axisTickWrap, { left: px }], [px]);
  return (
    <View style={wrapStyle}>
      <Text style={quota ? styles.axisQuotaLabel : styles.axisTickLabel} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
});

/**
 * Placeholder lane drawn when nothing is running or planned. Without it the
 * panel collapsed to a blank area and the axis lost its reference line — the
 * timeline has to stay readable even when the schedule is empty, so we keep one
 * quiet, empty lane instead of hiding the whole strip.
 */
const EmptyTimelineRow = memo(function EmptyTimelineRow({
  labelWidth,
  label,
}: {
  labelWidth: number;
  label: string;
}) {
  const labelCellStyle = useMemo(() => [styles.labelCell, { width: labelWidth }], [labelWidth]);
  return (
    <View style={styles.row} testID="tasks-gantt-empty-row">
      <View style={labelCellStyle}>
        <View style={[styles.rowDot, styles.rowDotEmpty]} />
        <Text style={styles.emptyLabelText} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <View style={[styles.track, styles.trackEmpty]} />
      <View style={startSpacerStyle} />
    </View>
  );
});

const TimelineRowView = memo(function TimelineRowView({
  row,
  labelWidth,
  onPressTask,
}: {
  row: TimelineRow;
  labelWidth: number;
  onPressTask: (task: KanbanTask) => void;
}) {
  const handlePress = useCallback(() => {
    onPressTask(row.task);
  }, [onPressTask, row.task]);

  const isRunning = row.column === "in_progress";
  const barStyle = useMemo(() => {
    const base = {
      left: `${row.leftPct}%` as const,
      width: `${row.widthPct}%` as const,
    };
    if (!row.estimated) {
      // Un-estimated: dashed outline in the column color, so an unknown size
      // reads differently from a measured one while keeping the lane's hue.
      return [
        styles.bar,
        base,
        isRunning ? styles.barOutlinedRunning : styles.barOutlinedScheduled,
      ];
    }
    // Estimated: solid fill in the column color — amber for what's running,
    // blue for what's planned — so the bar matches its kanban column at a glance.
    return [styles.bar, base, isRunning ? styles.barRunning : styles.barScheduled];
  }, [row.estimated, isRunning, row.leftPct, row.widthPct]);

  const dotStyle = isRunning ? styles.rowDotRunning : styles.rowDotScheduled;

  const startLabelStyle = isRunning ? styles.startTextRunning : styles.startText;

  const labelCellStyle = useMemo(() => [styles.labelCell, { width: labelWidth }], [labelWidth]);

  return (
    <Pressable
      style={rowPressableStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={row.task.title}
      testID={`tasks-gantt-row-${row.task.id}`}
    >
      <View style={labelCellStyle}>
        <View style={[styles.rowDot, dotStyle]} />
        <Text style={styles.labelText} numberOfLines={1}>
          {row.task.title}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={barStyle} />
      </View>
      <Text style={startLabelStyle} numberOfLines={1}>
        {row.startLabel}
      </Text>
    </Pressable>
  );
});

function rowPressableStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.row, (hovered || pressed) && styles.rowHovered];
}

const styles = StyleSheet.create((theme) => ({
  // Flat panel matching the board columns: no border, big radius, quiet
  // surface. Its outer gutter and inner padding mirror the kanban's, so the
  // panel edge lines up with the columns block and its text lines up with the
  // column headers. Vertical padding stays tight — the height comes from the
  // rows, not from padding.
  container: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius["2xl"],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  // Same inset as the web board's `boardRow` (desktop) …
  containerWideGutter: {
    marginHorizontal: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  // … and as `boardRowCompact` / the native scroller, so both blocks share one
  // left edge (see usesWideBoardGutter).
  containerTightGutter: {
    marginHorizontal: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
  },
  containerFill: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  // Wrapper around axis + rows: the full-height "now" and quota lines are
  // positioned against it in px (label column width is fixed).
  timelineBody: {
    position: "relative",
  },
  timelineBodyFill: {
    flex: 1,
  },
  axisRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: CELL_GAP,
    height: AXIS_HEIGHT,
    marginBottom: theme.spacing[1],
  },
  axisTrack: {
    flex: 1,
    position: "relative",
    height: "100%",
  },
  axisNowLabel: {
    position: "absolute",
    left: 0,
    bottom: 0,
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
  // Left-aligned at the tick's px position (the collision sweep guarantees the
  // reserved width to the right is clear), so no centering offset is needed.
  axisTickWrap: {
    position: "absolute",
    bottom: 0,
  },
  axisTickLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  axisQuotaLabel: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.xs,
  },
  rowsScrollFill: {
    flex: 1,
  },
  // Pinned height, not "whatever the tallest child measures": the panel height
  // is computed from ROW_HEIGHT, so a row that rendered taller (a text line box
  // above the track height) would silently overflow the computed area.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: CELL_GAP,
    height: ROW_HEIGHT,
    paddingVertical: ROW_VERTICAL_PADDING,
    borderRadius: theme.borderRadius.md,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  labelCell: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  // Row dots echo the kanban column color: amber = running, blue = planned.
  rowDotRunning: {
    backgroundColor: theme.colors.statusWarning,
  },
  rowDotScheduled: {
    backgroundColor: theme.colors.palette.blue[500],
  },
  // Empty lane: same shape as a real row, dimmed so it reads as "nothing here"
  // rather than as a task.
  rowDotEmpty: {
    opacity: 0.4,
  },
  labelText: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
  },
  emptyLabelText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  track: {
    flex: 1,
    height: ROW_TRACK_HEIGHT,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  trackEmpty: {
    opacity: 0.5,
  },
  bar: {
    position: "absolute",
    top: 2,
    bottom: 2,
    minWidth: 8,
    borderRadius: theme.borderRadius.base,
  },
  // Column-matched fills: amber for what's running, blue for what's planned —
  // the same hues as the "En cours" / "Planifié" kanban columns.
  barRunning: {
    backgroundColor: theme.colors.statusWarning,
  },
  barScheduled: {
    backgroundColor: theme.colors.palette.blue[500],
  },
  // Un-estimated: dashed outline in the same column hue (unknown size, known lane).
  barOutlinedRunning: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.statusWarning,
  },
  barOutlinedScheduled: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.palette.blue[500],
  },
  startText: {
    width: START_WIDTH,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontVariant: ["tabular-nums"],
  },
  startTextRunning: {
    width: START_WIDTH,
    textAlign: "right",
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.xs,
  },
  // Vertical "now" cursor: spans axis + rows, sits at the start of the track.
  nowLine: {
    position: "absolute",
    top: AXIS_HEIGHT,
    bottom: 0,
    width: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDanger,
    opacity: 0.55,
  },
  // End of the 5h quota window: dashed amber divider.
  quotaLine: {
    position: "absolute",
    top: AXIS_HEIGHT,
    bottom: 0,
    width: 1,
    borderLeftWidth: 1,
    borderStyle: "dashed",
    borderLeftColor: theme.colors.statusWarning,
  },
}));

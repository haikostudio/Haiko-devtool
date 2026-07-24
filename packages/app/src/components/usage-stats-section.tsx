import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { UsageStatsDay, UsageStatsProjectBucket } from "@getpaseo/protocol/messages";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { useIsCompactFormFactor } from "@/constants/layout";
import { baseColors } from "@/styles/theme";

// Static series palette — charts keep fixed colors across themes so a project
// keeps its color between renders and modes.
const SERIES_COLORS = [
  baseColors.blue[500],
  baseColors.green[500],
  baseColors.amber[500],
  baseColors.purple[500],
  baseColors.orange[500],
  baseColors.red[500],
] as const;
const OTHER_COLOR = baseColors.gray[500];

const MAX_SERIES_PROJECTS = SERIES_COLORS.length;
const DAYS_WINDOW = 14;
const HOURS_WINDOW = 24;
const CHART_HEIGHT = 140;

type ChartMode = "days" | "hours";

interface ChartSegment {
  color: string;
  value: number;
}

interface ChartBar {
  key: string;
  label: string;
  showLabel: boolean;
  total: number;
  segments: ChartSegment[];
}

interface SeriesProject {
  key: string;
  name: string;
  color: string;
}

interface UsageStatsSectionProps {
  days: UsageStatsDay[];
}

function projectActivity(project: UsageStatsProjectBucket): number {
  return project.inputTokens + project.cachedInputTokens + project.outputTokens;
}

function formatCost(value: number): string {
  if (value <= 0) {
    return "$0";
  }
  if (value < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  if (value < 100) {
    return `$${value.toFixed(2)}`;
  }
  return `$${Math.round(value)}`;
}

function sumProjects(days: UsageStatsDay[]): Map<string, UsageStatsProjectBucket> {
  const byKey = new Map<string, UsageStatsProjectBucket>();
  for (const day of days) {
    for (const project of day.projects) {
      const existing = byKey.get(project.key);
      if (!existing) {
        byKey.set(project.key, { ...project });
        continue;
      }
      existing.name = project.name;
      existing.inputTokens += project.inputTokens;
      existing.outputTokens += project.outputTokens;
      existing.cachedInputTokens += project.cachedInputTokens;
      existing.costUsd += project.costUsd;
      existing.turns += project.turns;
      existing.agentCount += project.agentCount;
    }
  }
  return byKey;
}

function pickSeriesProjects(totals: Map<string, UsageStatsProjectBucket>): SeriesProject[] {
  return Array.from(totals.values())
    .sort((a, b) => projectActivity(b) - projectActivity(a))
    .slice(0, MAX_SERIES_PROJECTS)
    .map((project, index) => ({
      key: project.key,
      name: project.name,
      color: SERIES_COLORS[index],
    }));
}

function bucketSegments(
  projects: UsageStatsProjectBucket[],
  series: SeriesProject[],
): { segments: ChartSegment[]; total: number } {
  const colorByKey = new Map(series.map((project) => [project.key, project.color] as const));
  const valueByColor = new Map<string, number>();
  let total = 0;
  for (const project of projects) {
    const value = projectActivity(project);
    if (value <= 0) {
      continue;
    }
    total += value;
    const color = colorByKey.get(project.key) ?? OTHER_COLOR;
    valueByColor.set(color, (valueByColor.get(color) ?? 0) + value);
  }
  // Keep the series order stable so stacks read consistently bar-to-bar.
  const segments: ChartSegment[] = [];
  for (const project of series) {
    const value = valueByColor.get(project.color);
    if (value) {
      segments.push({ color: project.color, value });
      valueByColor.delete(project.color);
    }
  }
  const otherValue = valueByColor.get(OTHER_COLOR);
  if (otherValue) {
    segments.push({ color: OTHER_COLOR, value: otherValue });
  }
  return { segments, total };
}

function buildDayBars(days: UsageStatsDay[], series: SeriesProject[]): ChartBar[] {
  const window = days.slice(-DAYS_WINDOW);
  return window.map((day) => {
    const { segments, total } = bucketSegments(day.projects, series);
    const dayOfMonth = Number.parseInt(day.date.slice(8, 10), 10);
    return {
      key: day.date,
      label: String(dayOfMonth),
      showLabel: true,
      total,
      segments,
    };
  });
}

function buildHourBars(days: UsageStatsDay[], series: SeriesProject[], now: Date): ChartBar[] {
  // The last two day entries cover the trailing 24 hours.
  const byDateHour = new Map<string, UsageStatsProjectBucket[]>();
  for (const day of days.slice(-2)) {
    for (const hour of day.hours) {
      byDateHour.set(`${day.date}:${hour.hour}`, hour.projects);
    }
  }
  const bars: ChartBar[] = [];
  for (let offset = HOURS_WINDOW - 1; offset >= 0; offset -= 1) {
    const slot = new Date(now.getTime() - offset * 60 * 60 * 1000);
    const year = slot.getFullYear();
    const month = String(slot.getMonth() + 1).padStart(2, "0");
    const dayOfMonth = String(slot.getDate()).padStart(2, "0");
    const dateKey = `${year}-${month}-${dayOfMonth}`;
    const projects = byDateHour.get(`${dateKey}:${slot.getHours()}`) ?? [];
    const { segments, total } = bucketSegments(projects, series);
    bars.push({
      key: `${dateKey}:${slot.getHours()}`,
      label: `${slot.getHours()}h`,
      showLabel: true,
      total,
      segments,
    });
  }
  return bars;
}

export function UsageStatsSection({ days }: UsageStatsSectionProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [mode, setMode] = useState<ChartMode>("days");
  const showDays = useCallback(() => setMode("days"), []);
  const showHours = useCallback(() => setMode("hours"), []);

  // On phones the default insets waste a lot of horizontal space, so tighten the
  // outer and card paddings when compact.
  const containerStyle = useMemo(
    () => [styles.container, isCompact && styles.containerCompact],
    [isCompact],
  );
  const chartCardStyle = useMemo(
    () => [styles.chartCard, isCompact && styles.cardCompact],
    [isCompact],
  );
  const tableCardStyle = useMemo(
    () => [styles.tableCard, isCompact && styles.tableCardCompact],
    [isCompact],
  );

  const totalsByProject = useMemo(() => sumProjects(days), [days]);
  const series = useMemo(() => pickSeriesProjects(totalsByProject), [totalsByProject]);

  const bars = useMemo(() => {
    if (mode === "days") {
      return buildDayBars(days, series);
    }
    return buildHourBars(days, series, new Date());
  }, [days, series, mode]);

  const summary = useMemo(() => {
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let turns = 0;
    for (const project of totalsByProject.values()) {
      inputTokens += project.inputTokens + project.cachedInputTokens;
      outputTokens += project.outputTokens;
      costUsd += project.costUsd;
      turns += project.turns;
    }
    const today = days.length > 0 ? days[days.length - 1] : null;
    const agentsToday = today
      ? today.projects.reduce((sum, project) => sum + project.agentCount, 0)
      : 0;
    return { inputTokens, outputTokens, costUsd, turns, agentsToday };
  }, [days, totalsByProject]);

  const projectRows = useMemo(
    () =>
      Array.from(totalsByProject.values())
        .sort((a, b) => projectActivity(b) - projectActivity(a))
        .slice(0, 8),
    [totalsByProject],
  );

  const hasData = summary.inputTokens > 0 || summary.outputTokens > 0 || summary.turns > 0;
  const maxBarTotal = Math.max(1, ...bars.map((bar) => bar.total));
  const colorByProjectKey = useMemo(
    () => new Map(series.map((project) => [project.key, project.color] as const)),
    [series],
  );

  return (
    <View style={containerStyle}>
      <View style={styles.cardsRow}>
        <SummaryCard label={t("dashboard.stats.agentsToday")} value={String(summary.agentsToday)} />
        <SummaryCard
          label={t("dashboard.stats.tokensIn")}
          value={formatTokenCount(summary.inputTokens)}
        />
        <SummaryCard
          label={t("dashboard.stats.tokensOut")}
          value={formatTokenCount(summary.outputTokens)}
        />
        <SummaryCard
          label={t("dashboard.stats.estimatedCost")}
          value={formatCost(summary.costUsd)}
        />
      </View>

      <View style={chartCardStyle}>
        <View style={styles.chartHeader}>
          <Text style={styles.chartTitle}>{t("dashboard.stats.activityTitle")}</Text>
          <View style={styles.modeToggle}>
            <ModeButton
              label={t("dashboard.stats.modeDays")}
              active={mode === "days"}
              onPress={showDays}
            />
            <ModeButton
              label={t("dashboard.stats.modeHours")}
              active={mode === "hours"}
              onPress={showHours}
            />
          </View>
        </View>

        {hasData ? (
          <>
            <View style={styles.chartArea}>
              {bars.map((bar) => (
                <View key={bar.key} style={styles.barColumn}>
                  <View style={styles.barTrack}>
                    {bar.segments.map((segment) => (
                      <View
                        key={segment.color}
                        style={styles.barSegment(
                          Math.max(2, Math.round((segment.value / maxBarTotal) * CHART_HEIGHT)),
                          segment.color,
                        )}
                      />
                    ))}
                  </View>
                  <Text style={styles.barLabel} numberOfLines={1}>
                    {bar.showLabel ? bar.label : " "}
                  </Text>
                </View>
              ))}
            </View>
            <View style={styles.legendRow}>
              {series.map((project) => (
                <View key={project.key} style={styles.legendItem}>
                  <View style={styles.legendDot(project.color)} />
                  <Text style={styles.legendLabel} numberOfLines={1}>
                    {project.name}
                  </Text>
                </View>
              ))}
              {totalsByProject.size > series.length ? (
                <View style={styles.legendItem}>
                  <View style={styles.legendDot(OTHER_COLOR)} />
                  <Text style={styles.legendLabel}>{t("dashboard.stats.otherProjects")}</Text>
                </View>
              ) : null}
            </View>
          </>
        ) : (
          <Text style={styles.emptyText}>{t("dashboard.stats.empty")}</Text>
        )}
      </View>

      {projectRows.length > 0 ? (
        <View style={tableCardStyle}>
          <View style={styles.tableHeaderRow}>
            <Text style={styles.tableHeaderProject}>{t("dashboard.stats.columnProject")}</Text>
            <Text style={styles.tableHeaderNumber}>{t("dashboard.stats.columnAgents")}</Text>
            <Text style={styles.tableHeaderNumber}>{t("dashboard.stats.columnTokens")}</Text>
            <Text style={styles.tableHeaderNumber}>{t("dashboard.stats.columnCost")}</Text>
          </View>
          {projectRows.map((project) => (
            <View key={project.key} style={styles.tableRow}>
              <View style={styles.projectCell}>
                <View style={styles.legendDot(colorByProjectKey.get(project.key) ?? OTHER_COLOR)} />
                <Text style={styles.projectName} numberOfLines={1}>
                  {project.name}
                </Text>
              </View>
              <Text style={styles.tableValueNumber}>{project.agentCount}</Text>
              <Text style={styles.tableValueNumber}>
                {formatTokenCount(projectActivity(project))}
              </Text>
              <Text style={styles.tableValueNumber}>{formatCost(project.costUsd)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryCard}>
      <Text style={styles.summaryValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.summaryLabel} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

function ModeButton({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.modeButton(active)}
      accessibilityRole="button"
      accessibilityState={useMemo(() => ({ selected: active }), [active])}
    >
      <Text style={styles.modeButtonLabel(active)}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[4],
  },
  containerCompact: {
    paddingHorizontal: theme.spacing[2],
  },
  cardCompact: {
    padding: theme.spacing[2],
  },
  tableCardCompact: {
    paddingHorizontal: theme.spacing[2],
  },
  cardsRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  summaryCard: {
    flex: 1,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    alignItems: "center",
    gap: theme.spacing[1],
  },
  summaryValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  summaryLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
  chartCard: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  chartHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  chartTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  modeToggle: {
    flexDirection: "row",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.full,
    padding: theme.spacing[1],
  },
  modeButton: (active: boolean) => ({
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: active ? theme.colors.surface0 : "transparent",
  }),
  modeButtonLabel: (active: boolean) => ({
    color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  }),
  chartArea: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[1],
    height: CHART_HEIGHT + 18,
  },
  barColumn: {
    flex: 1,
    alignItems: "stretch",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
  barTrack: {
    justifyContent: "flex-end",
    gap: 1,
  },
  barSegment: (height: number, color: string) => ({
    height,
    backgroundColor: color,
    borderRadius: 2,
  }),
  barLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: 9,
    textAlign: "center",
  },
  legendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 140,
  },
  legendDot: (color: string) => ({
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: color,
  }),
  legendLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingVertical: theme.spacing[4],
    textAlign: "center",
  },
  tableCard: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  tableHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  tableHeaderProject: {
    flex: 2,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
  },
  tableHeaderNumber: {
    flex: 1,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
  },
  tableRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.surface2,
  },
  projectCell: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  projectName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  tableValueNumber: {
    flex: 1,
    textAlign: "right",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));

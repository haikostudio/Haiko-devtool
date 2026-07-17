import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AggregatedActivityEntry } from "@/data/activity";
import { deriveProjectIconColor } from "@/utils/project-icon-color";
import type { Theme } from "@/styles/theme";

// How many projects get their own colored bar before the tail is folded into a
// single grey "Autres" bar. Keeps the header bounded on small screens.
const MAX_BARS = 6;
const OTHER_COLOR = "#6b7280";

interface ProjectBar {
  name: string;
  count: number;
  color: string;
  /** "Autres" is an aggregate, not a real project — not selectable. */
  selectable: boolean;
}

interface ActivityProjectChartProps {
  entries: AggregatedActivityEntry[];
  /** The active project filter, or the all-projects sentinel. */
  activeProject: string;
  allProjectsValue: string;
  onSelectProject: (project: string) => void;
}

function buildBars(entries: AggregatedActivityEntry[]): ProjectBar[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.projectName, (counts.get(entry.projectName) ?? 0) + 1);
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, MAX_BARS).map(([name, count]) => ({
    name,
    count,
    color: deriveProjectIconColor(name),
    selectable: true,
  }));
  const tail = sorted.slice(MAX_BARS);
  if (tail.length > 0) {
    head.push({
      name: "__other__",
      count: tail.reduce((sum, [, count]) => sum + count, 0),
      color: OTHER_COLOR,
      selectable: false,
    });
  }
  return head;
}

/**
 * Colored per-project breakdown of the activity log — one bar per project,
 * width proportional to how many agents are active there, tinted with the
 * project's own color. Tapping a bar drives the screen's project filter.
 */
export function ActivityProjectChart({
  entries,
  activeProject,
  allProjectsValue,
  onSelectProject,
}: ActivityProjectChartProps) {
  const { t } = useTranslation();
  const bars = useMemo(() => buildBars(entries), [entries]);
  const maxCount = useMemo(() => Math.max(1, ...bars.map((bar) => bar.count)), [bars]);

  // Only worth showing once activity spans more than one project.
  if (bars.length < 2) {
    return null;
  }

  const filtered = activeProject !== allProjectsValue;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{t("dashboard.stats.activityTitle")}</Text>
      <View style={styles.bars}>
        {bars.map((bar) => (
          <ProjectBarRow
            key={bar.name}
            bar={bar}
            widthPct={(bar.count / maxCount) * 100}
            active={filtered && bar.selectable && bar.name === activeProject}
            dimmed={filtered && !(bar.selectable && bar.name === activeProject)}
            onSelectProject={onSelectProject}
          />
        ))}
      </View>
    </View>
  );
}

function ProjectBarRow({
  bar,
  widthPct,
  active,
  dimmed,
  onSelectProject,
}: {
  bar: ProjectBar;
  widthPct: number;
  active: boolean;
  dimmed: boolean;
  onSelectProject: (project: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    if (bar.selectable) {
      onSelectProject(bar.name);
    }
  }, [bar.selectable, bar.name, onSelectProject]);

  const label = bar.selectable ? bar.name : t("dashboard.stats.otherProjects");

  return (
    <Pressable
      onPress={handlePress}
      disabled={!bar.selectable}
      style={styles.row(active)}
      testID={bar.selectable ? `activity-chart-bar-${bar.name}` : undefined}
    >
      <Text style={styles.rowLabel(active)} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.track}>
        <View style={styles.fill(widthPct, bar.color, dimmed)} />
      </View>
      <Text style={styles.rowCount}>{bar.count}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    marginBottom: theme.spacing[3],
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  bars: {
    gap: theme.spacing[1],
  },
  row: (active: boolean) => ({
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: active ? theme.colors.surface2 : "transparent",
  }),
  rowLabel: (active: boolean) => ({
    width: 104,
    color: active ? theme.colors.foreground : theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: active ? theme.fontWeight.medium : theme.fontWeight.normal,
  }),
  track: {
    flex: 1,
    height: 10,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  fill: (widthPct: number, color: string, dimmed: boolean) => ({
    height: 10,
    width: `${Math.max(4, widthPct)}%`,
    borderRadius: theme.borderRadius.full,
    backgroundColor: color,
    opacity: dimmed ? 0.45 : 1,
  }),
  rowCount: {
    minWidth: 28,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontVariant: ["tabular-nums"],
  },
}));

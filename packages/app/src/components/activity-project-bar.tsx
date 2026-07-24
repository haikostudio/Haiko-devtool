import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AggregatedActivityEntry } from "@/data/activity";
import { deriveProjectIconColor } from "@/utils/project-icon-color";
import type { Theme } from "@/styles/theme";

interface Segment {
  key: string;
  count: number;
  pct: number;
  color: string;
}

function buildSegments(entries: AggregatedActivityEntry[]): Segment[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.projectName, (counts.get(entry.projectName) ?? 0) + 1);
  }
  const total = entries.length || 1;
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      key: name,
      count,
      pct: Math.round((count / total) * 100),
      color: deriveProjectIconColor(name),
    }));
}

/**
 * One full-width bar split into a colored slice per project, each slice sized by
 * how many agents are active there and labelled with its share. Every slice uses
 * the project's own color — the same color as that project's tag on each row.
 */
export function ActivityProjectBar({ entries }: { entries: AggregatedActivityEntry[] }) {
  const segments = useMemo(() => buildSegments(entries), [entries]);
  if (segments.length === 0) {
    return null;
  }
  return (
    <View style={styles.bar}>
      {segments.map((segment) => (
        <View key={segment.key} style={styles.segment(segment.count, segment.color)}>
          <Text style={styles.label} numberOfLines={1}>
            {segment.pct}%
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  bar: {
    flexDirection: "row",
    height: 88,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
    marginHorizontal: theme.spacing[4],
    marginTop: theme.spacing[3],
    marginBottom: theme.spacing[2],
    // 1px of the track shows through as a hairline between adjacent slices.
    gap: 1,
  },
  segment: (count: number, color: string) => ({
    flexGrow: count,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    backgroundColor: color,
  }),
  label: {
    color: "#ffffff",
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
}));

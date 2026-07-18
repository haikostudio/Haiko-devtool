import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { AggregatedActivityEntry } from "@/data/activity";
import { deriveProjectIconColor } from "@/utils/project-icon-color";
import type { Theme } from "@/styles/theme";

interface Segment {
  key: string;
  count: number;
  color: string;
}

function buildSegments(entries: AggregatedActivityEntry[]): Segment[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry.projectName, (counts.get(entry.projectName) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ key: name, count, color: deriveProjectIconColor(name) }));
}

/**
 * One full-width bar split into a colored slice per project, each slice sized by
 * how many agents are active there. Every slice uses the project's own color —
 * the same color as that project's tag on each row below.
 */
export function ActivityProjectBar({ entries }: { entries: AggregatedActivityEntry[] }) {
  const segments = useMemo(() => buildSegments(entries), [entries]);
  if (segments.length === 0) {
    return null;
  }
  return (
    <View style={styles.bar}>
      {segments.map((segment) => (
        <View key={segment.key} style={styles.segment(segment.count, segment.color)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  bar: {
    flexDirection: "row",
    height: 12,
    borderRadius: theme.borderRadius.full,
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
    backgroundColor: color,
  }),
}));

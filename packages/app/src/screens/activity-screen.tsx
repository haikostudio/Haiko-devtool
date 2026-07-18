import { useCallback, useMemo, useState } from "react";
import { FlatList, type ListRenderItem, Pressable, ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ActivityProjectChart } from "@/components/activity-project-chart";
import { MenuHeader } from "@/components/headers/menu-header";
import { getProviderIcon } from "@/components/provider-icons";
import { useActivityLog, type AggregatedActivityEntry } from "@/data/activity";
import { formatTimeAgo } from "@/utils/time";
import type { Theme } from "@/styles/theme";

const ALL_PROJECTS = "__all__";

const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// The provider glyph takes a runtime color, which cannot flow through the
// tracked `style` prop. withUnistyles is the sanctioned way to feed a
// theme-reactive prop into a component without re-rendering the whole list.
function ProviderGlyph({ provider, size }: { provider: string; size: number }) {
  const Themed = useMemo(() => withUnistyles(getProviderIcon(provider)), [provider]);
  return <Themed size={size} uniProps={mutedIconColor} />;
}

function ActivityRow({ entry }: { entry: AggregatedActivityEntry }) {
  return (
    <View style={styles.row} testID={`activity-row-${entry.serverId}-${entry.agentId}`}>
      <View style={styles.rowIcon}>
        <ProviderGlyph provider={entry.provider} size={ICON_SIZE} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {entry.title}
        </Text>
        <View style={styles.rowMeta}>
          <Text style={styles.rowProject} numberOfLines={1}>
            {entry.projectName}
          </Text>
          <Text style={styles.rowDot}>·</Text>
          <Text style={styles.rowTime}>{formatTimeAgo(new Date(entry.updatedAt))}</Text>
        </View>
      </View>
    </View>
  );
}

const ICON_SIZE = 18;

const renderRow: ListRenderItem<AggregatedActivityEntry> = ({ item }) => (
  <ActivityRow entry={item} />
);
const rowKey = (item: AggregatedActivityEntry) => `${item.serverId}:${item.id}`;

export function ActivityScreen() {
  const isFocused = useIsFocused();
  if (!isFocused) {
    return <View style={styles.container} />;
  }
  return <ActivityScreenContent />;
}

function ActivityScreenContent() {
  const { t } = useTranslation();
  const { entries, isLoading } = useActivityLog();
  const [projectFilter, setProjectFilter] = useState<string>(ALL_PROJECTS);
  const handleSelect = useCallback((value: string) => setProjectFilter(value), []);

  const projectNames = useMemo(() => {
    const names = new Set<string>();
    for (const entry of entries) {
      names.add(entry.projectName);
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  }, [entries]);

  // Reset the filter if the selected project drops out of the log.
  const activeFilter =
    projectFilter !== ALL_PROJECTS && !projectNames.includes(projectFilter)
      ? ALL_PROJECTS
      : projectFilter;

  const visibleEntries = useMemo(
    () =>
      activeFilter === ALL_PROJECTS
        ? entries
        : entries.filter((entry) => entry.projectName === activeFilter),
    [entries, activeFilter],
  );

  // The chart summarizes every project, so it reads from the full log rather
  // than the filtered view; tapping a bar drives the same filter as the chips.
  const chartHeader = useMemo(
    () => (
      <ActivityProjectChart
        entries={entries}
        activeProject={activeFilter}
        allProjectsValue={ALL_PROJECTS}
        onSelectProject={handleSelect}
      />
    ),
    [entries, activeFilter, handleSelect],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title={t("activity.title")} />
      {projectNames.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.filtersScroll}
          contentContainerStyle={styles.filters}
        >
          <FilterChip
            label={t("activity.filter.all")}
            value={ALL_PROJECTS}
            active={activeFilter === ALL_PROJECTS}
            onSelect={handleSelect}
            testID="activity-filter-all"
          />
          {projectNames.map((name) => (
            <FilterChip
              key={name}
              label={name}
              value={name}
              active={activeFilter === name}
              onSelect={handleSelect}
              testID={`activity-filter-${name}`}
            />
          ))}
        </ScrollView>
      ) : null}
      {visibleEntries.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>
            {isLoading ? t("activity.loading") : t("activity.empty")}
          </Text>
        </View>
      ) : (
        <FlatList
          data={visibleEntries}
          renderItem={renderRow}
          keyExtractor={rowKey}
          ListHeaderComponent={chartHeader}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

function FilterChip({
  label,
  value,
  active,
  onSelect,
  testID,
}: {
  label: string;
  value: string;
  active: boolean;
  onSelect: (value: string) => void;
  testID: string;
}) {
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  const chipStyle = useMemo(() => [styles.chip, active && styles.chipActive], [active]);
  const labelStyle = useMemo(() => [styles.chipLabel, active && styles.chipLabelActive], [active]);
  return (
    <Pressable onPress={handlePress} testID={testID} style={chipStyle}>
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  // A horizontal ScrollView inherits RNW's flex-grow, so inside this column it
  // stretches vertically and drags the chips into full-height capsules. Pin it
  // to its content height and stop the chips from stretching.
  filtersScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  filters: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  chip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipActive: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.foregroundMuted,
  },
  chipLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  chipLabelActive: {
    color: theme.colors.foreground,
  },
  listContent: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[8],
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowIcon: {
    paddingTop: theme.spacing[1],
  },
  rowBody: {
    flex: 1,
    gap: theme.spacing[1],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  rowMeta: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowProject: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  rowDot: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  rowTime: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.lg,
    textAlign: "center",
  },
}));

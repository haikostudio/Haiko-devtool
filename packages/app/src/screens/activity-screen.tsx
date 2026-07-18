import { useCallback, useMemo, useState } from "react";
import { FlatList, type ListRenderItem, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ListFilter } from "lucide-react-native";
import { ActivityProjectBar } from "@/components/activity-project-bar";
import { MenuHeader } from "@/components/headers/menu-header";
import { getProviderIcon } from "@/components/provider-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useActivityLog, type AggregatedActivityEntry } from "@/data/activity";
import { deriveProjectIconColor } from "@/utils/project-icon-color";
import { formatTimeAgo } from "@/utils/time";
import type { Theme } from "@/styles/theme";

const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentIconColor = (theme: Theme) => ({ color: theme.colors.accent });

// The provider glyph takes a runtime color, which cannot flow through the
// tracked `style` prop. withUnistyles is the sanctioned way to feed a
// theme-reactive prop into a component without re-rendering the whole list.
function ProviderGlyph({ provider, size }: { provider: string; size: number }) {
  const Themed = useMemo(() => withUnistyles(getProviderIcon(provider)), [provider]);
  return <Themed size={size} uniProps={mutedIconColor} />;
}

const ThemedListFilter = withUnistyles(ListFilter);

function ActivityRow({ entry }: { entry: AggregatedActivityEntry }) {
  // The project tag carries the project's own color — the same color as its
  // slice in the bar above.
  const projectTagStyle = useMemo(
    () => [styles.rowProject, { color: deriveProjectIconColor(entry.projectName) }],
    [entry.projectName],
  );
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
          <Text style={projectTagStyle} numberOfLines={1}>
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
  // Projects the user has toggled off. Empty = show everything; new projects
  // appear enabled by default.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());

  const projectNames = useMemo(() => {
    const names = new Set<string>();
    for (const entry of entries) {
      names.add(entry.projectName);
    }
    return [...names].sort((left, right) => left.localeCompare(right));
  }, [entries]);

  const toggleProject = useCallback((name: string) => {
    setHidden((previous) => {
      const next = new Set(previous);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const visibleEntries = useMemo(
    () => (hidden.size === 0 ? entries : entries.filter((entry) => !hidden.has(entry.projectName))),
    [entries, hidden],
  );

  const rightContent = useMemo(
    () =>
      projectNames.length > 1 ? (
        <ProjectFilterMenu projects={projectNames} hidden={hidden} onToggle={toggleProject} />
      ) : null,
    [projectNames, hidden, toggleProject],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title={t("activity.title")} rightContent={rightContent} />
      {visibleEntries.length > 0 ? <ActivityProjectBar entries={visibleEntries} /> : null}
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
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

function ProjectFilterMenu({
  projects,
  hidden,
  onToggle,
}: {
  projects: string[];
  hidden: ReadonlySet<string>;
  onToggle: (name: string) => void;
}) {
  const active = hidden.size > 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger style={styles.filterTrigger} testID="activity-project-filter-trigger">
        <ThemedListFilter size={18} uniProps={active ? accentIconColor : mutedIconColor} />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" scrollable maxHeight={360}>
        {projects.map((name) => (
          <ProjectFilterItem
            key={name}
            name={name}
            selected={!hidden.has(name)}
            onToggle={onToggle}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ProjectFilterItem({
  name,
  selected,
  onToggle,
}: {
  name: string;
  selected: boolean;
  onToggle: (name: string) => void;
}) {
  const handleSelect = useCallback(() => onToggle(name), [onToggle, name]);
  const dotStyle = useMemo(
    () => [styles.filterDot, { backgroundColor: deriveProjectIconColor(name) }],
    [name],
  );
  const leading = useMemo(() => <View style={dotStyle} />, [dotStyle]);
  return (
    <DropdownMenuItem
      showSelectedCheck
      selected={selected}
      closeOnSelect={false}
      leading={leading}
      onSelect={handleSelect}
      testID={`activity-project-filter-${name}`}
    >
      {name}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  filterTrigger: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  filterDot: {
    width: 10,
    height: 10,
    borderRadius: theme.borderRadius.full,
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
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
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

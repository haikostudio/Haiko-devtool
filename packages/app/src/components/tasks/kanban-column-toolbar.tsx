import { memo, useCallback, useMemo } from "react";
import { View } from "react-native";
import { ListFilter } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { FormTextInput } from "@/components/ui/form-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TaskBoard, TaskColumn } from "@/data/tasks";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  collectBoardFacets,
  EMPTY_TASK_FILTER,
  taskFilterCount,
  useFilterLabels,
  type ColumnControls,
  type DeadlineFilter,
  type FilterPriorityLevel,
  type TaskFilter,
} from "./kanban-columns";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedFilter = withUnistyles(ListFilter);

// Plain (non-Unistyles) style: FormTextInput's chrome/input style split runs the
// value through RN's StyleSheet.flatten, which silently drops Unistyles proxy
// styles. A plain object survives it, so this is the reliable way to knock out
// the input's default grey chrome and let the white wrapper show through.
const TRANSPARENT_CHROME = { backgroundColor: "transparent" } as const;

function iconButtonStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.iconButton, (hovered || pressed) && styles.iconButtonHovered];
}

/**
 * Per-column search / filter / sort toolbar. Each column carries its own copy
 * so a query or facet narrows only that column's cards — the board no longer
 * has a single shared bar above all the columns.
 */
export const BoardColumnToolbar = memo(function BoardColumnToolbar({
  board,
  folderId,
  column,
  controls,
  onChange,
}: {
  board: TaskBoard | null;
  folderId: string;
  column: TaskColumn;
  controls: ColumnControls;
  onChange: (next: ColumnControls) => void;
}) {
  const { t } = useTranslation();

  const handleQueryChange = useCallback(
    (query: string) => onChange({ ...controls, query }),
    [controls, onChange],
  );
  const handleFilterChange = useCallback(
    (filter: TaskFilter) => onChange({ ...controls, filter }),
    [controls, onChange],
  );

  return (
    <View style={styles.toolbar}>
      <View style={styles.searchField}>
        <FormTextInput
          size="sm"
          value={controls.query}
          onChangeText={handleQueryChange}
          placeholder={t("tasks.searchTasks")}
          style={TRANSPARENT_CHROME}
          testID={`tasks-column-search-${column}`}
        />
      </View>
      <ColumnFilterMenu
        board={board}
        folderId={folderId}
        column={column}
        filter={controls.filter}
        onChange={handleFilterChange}
      />
    </View>
  );
});

// A single toggle row inside the filter menu. Binds its own value so the parent
// can pass a stable handler (no inline closure per row). closeOnSelect is false
// so the user can flip several facets in one open of the menu.
const FilterCheckItem = memo(function FilterCheckItem({
  value,
  label,
  selected,
  onToggle,
}: {
  value: string;
  label: string;
  selected: boolean;
  onToggle: (value: string) => void;
}) {
  const handleToggle = useCallback(() => onToggle(value), [onToggle, value]);
  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      closeOnSelect={false}
      onSelect={handleToggle}
    >
      {label}
    </DropdownMenuItem>
  );
});

// Faceted filter behind the funnel button: only the facets present in this
// column are offered (priorities, deadline states, thematic tags), plus a Clear
// row once anything is active. A dot on the trigger signals an active filter.
const ColumnFilterMenu = memo(function ColumnFilterMenu({
  board,
  folderId,
  column,
  filter,
  onChange,
}: {
  board: TaskBoard | null;
  folderId: string;
  column: TaskColumn;
  filter: TaskFilter;
  onChange: (next: TaskFilter) => void;
}) {
  const labels = useFilterLabels();
  const facets = useMemo(
    () => collectBoardFacets(board, folderId, column),
    [board, folderId, column],
  );
  const activeCount = taskFilterCount(filter);

  const togglePriority = useCallback(
    (value: string) => {
      const level = value as FilterPriorityLevel;
      onChange({
        ...filter,
        priorities: filter.priorities.includes(level)
          ? filter.priorities.filter((entry) => entry !== level)
          : [...filter.priorities, level],
      });
    },
    [filter, onChange],
  );
  const toggleDeadline = useCallback(
    (value: string) => {
      const entry = value as DeadlineFilter;
      onChange({
        ...filter,
        deadline: filter.deadline.includes(entry)
          ? filter.deadline.filter((current) => current !== entry)
          : [...filter.deadline, entry],
      });
    },
    [filter, onChange],
  );
  const toggleTag = useCallback(
    (tag: string) => {
      onChange({
        ...filter,
        tags: filter.tags.includes(tag)
          ? filter.tags.filter((entry) => entry !== tag)
          : [...filter.tags, tag],
      });
    },
    [filter, onChange],
  );
  const clear = useCallback(() => onChange(EMPTY_TASK_FILTER), [onChange]);

  const hasFacets = facets.priorities.length > 0 || facets.hasDeadlines || facets.tags.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={iconButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={labels.title}
        testID={`tasks-column-filter-${column}`}
      >
        <View style={styles.filterTriggerInner}>
          <ThemedFilter size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          {activeCount > 0 ? <View style={styles.filterActiveDot} /> : null}
        </View>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" minWidth={200} scrollable maxHeight={360}>
        {!hasFacets ? <DropdownMenuHint>{labels.empty}</DropdownMenuHint> : null}
        {facets.priorities.length > 0 ? (
          <>
            <DropdownMenuLabel>{labels.priorityHeading}</DropdownMenuLabel>
            {facets.priorities.map((level) => (
              <FilterCheckItem
                key={`priority-${level}`}
                value={level}
                label={labels.priority[level]}
                selected={filter.priorities.includes(level)}
                onToggle={togglePriority}
              />
            ))}
          </>
        ) : null}
        {facets.hasDeadlines ? (
          <>
            <DropdownMenuLabel>{labels.deadlineHeading}</DropdownMenuLabel>
            <FilterCheckItem
              value="overdue"
              label={labels.deadline.overdue}
              selected={filter.deadline.includes("overdue")}
              onToggle={toggleDeadline}
            />
            <FilterCheckItem
              value="none"
              label={labels.deadline.none}
              selected={filter.deadline.includes("none")}
              onToggle={toggleDeadline}
            />
          </>
        ) : null}
        {facets.tags.length > 0 ? (
          <>
            <DropdownMenuLabel>{labels.tagsHeading}</DropdownMenuLabel>
            {facets.tags.map((tag) => (
              <FilterCheckItem
                key={`tag-${tag}`}
                value={tag}
                label={tag}
                selected={filter.tags.includes(tag)}
                onToggle={toggleTag}
              />
            ))}
          </>
        ) : null}
        {activeCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive closeOnSelect={false} onSelect={clear}>
              {labels.clear}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const styles = StyleSheet.create((theme) => ({
  // Sits in the column header, between the title row and the cards. Spans the
  // full column width: the search field grows to fill, the funnel button stays
  // a fixed square on the right.
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  // White, bordered wrapper so the field reads as an input against the grey
  // column surface. flex:1 here (a plain View) reliably fills the row — the
  // FormTextInput's own flex/background style is dropped by its style split.
  searchField: {
    flex: 1,
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  iconButton: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  iconButtonHovered: {
    backgroundColor: theme.colors.surface1,
  },
  filterTriggerInner: {
    alignItems: "center",
    justifyContent: "center",
  },
  filterActiveDot: {
    position: "absolute",
    top: -5,
    right: -5,
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[500],
  },
}));

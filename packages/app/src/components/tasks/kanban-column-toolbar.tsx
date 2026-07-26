import { memo, useCallback } from "react";
import { View } from "react-native";
import { ArrowDownUp } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { FormTextInput } from "@/components/ui/form-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { TaskColumn } from "@/data/tasks";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  COLUMN_SORT_MODES,
  DEFAULT_COLUMN_SORT,
  useSortLabels,
  type ColumnControls,
  type ColumnSortMode,
} from "./kanban-columns";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedSort = withUnistyles(ArrowDownUp);

// Plain (non-Unistyles) style: FormTextInput's chrome/input style split runs the
// value through RN's StyleSheet.flatten, which silently drops Unistyles proxy
// styles. A plain object survives it, so this is the reliable way to knock out
// the input's default grey chrome and let the white wrapper show through.
const TRANSPARENT_CHROME = { backgroundColor: "transparent" } as const;

function iconButtonStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.iconButton, (hovered || pressed) && styles.iconButtonHovered];
}

/**
 * Per-column search + sort toolbar. Each column carries its own copy so a query
 * or an ordering applies to that column alone — the board has no single shared
 * bar above all the columns.
 *
 * The sort button replaces the faceted filter that briefly stood here: the board
 * is read by scanning columns, so choosing an order beats hiding cards.
 */
export const BoardColumnToolbar = memo(function BoardColumnToolbar({
  column,
  controls,
  onChange,
}: {
  column: TaskColumn;
  controls: ColumnControls;
  onChange: (next: ColumnControls) => void;
}) {
  const { t } = useTranslation();

  const handleQueryChange = useCallback(
    (query: string) => onChange({ ...controls, query }),
    [controls, onChange],
  );
  const handleSortChange = useCallback(
    (sort: ColumnSortMode) => onChange({ ...controls, sort }),
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
      <ColumnSortMenu column={column} sort={controls.sort} onChange={handleSortChange} />
    </View>
  );
});

// A single sort row. Binds its own value so the parent can pass a stable handler
// (no inline closure per row).
const SortItem = memo(function SortItem({
  value,
  label,
  selected,
  onSelect,
}: {
  value: ColumnSortMode;
  label: string;
  selected: boolean;
  onSelect: (value: ColumnSortMode) => void;
}) {
  const handleSelect = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <DropdownMenuItem selected={selected} showSelectedCheck onSelect={handleSelect}>
      {label}
    </DropdownMenuItem>
  );
});

// Sort menu behind the arrows button. A dot on the trigger signals the column is
// on something other than the default (last modified, most recent first).
const ColumnSortMenu = memo(function ColumnSortMenu({
  column,
  sort,
  onChange,
}: {
  column: TaskColumn;
  sort: ColumnSortMode;
  onChange: (next: ColumnSortMode) => void;
}) {
  const labels = useSortLabels();
  const isCustom = sort !== DEFAULT_COLUMN_SORT;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={iconButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={labels.title}
        testID={`tasks-column-sort-${column}`}
      >
        <View style={styles.sortTriggerInner}>
          <ThemedSort size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          {isCustom ? <View style={styles.sortActiveDot} /> : null}
        </View>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" minWidth={200}>
        <DropdownMenuLabel>{labels.title}</DropdownMenuLabel>
        {COLUMN_SORT_MODES.map((mode) => (
          <SortItem
            key={mode}
            value={mode}
            label={labels.modes[mode]}
            selected={sort === mode}
            onSelect={onChange}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const styles = StyleSheet.create((theme) => ({
  // Sits in the column header, between the title row and the cards. Spans the
  // full column width: the search field grows to fill, the sort button stays a
  // fixed square on the right.
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
  sortTriggerInner: {
    alignItems: "center",
    justifyContent: "center",
  },
  sortActiveDot: {
    position: "absolute",
    top: -5,
    right: -5,
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[500],
  },
}));

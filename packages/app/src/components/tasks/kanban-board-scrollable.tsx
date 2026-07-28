import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ChevronsRight, Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { KanbanTask, TaskBoard, TaskColumn } from "@/data/tasks";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { TaskCard } from "./task-card";
import { TaskCardMenu } from "./task-card-menu";
import { BoardColumnToolbar } from "./kanban-column-toolbar";
import {
  buildColumnModels,
  EMPTY_COLUMN_CONTROLS,
  useColumnLabels,
  type ColumnControls,
  type ColumnControlsMap,
  type KanbanBoardProps,
} from "./kanban-columns";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedPlus = withUnistyles(Plus);
const ThemedChevronsRight = withUnistyles(ChevronsRight);

// Shared by the board row styles and the compact snap interval — keep in sync.
const COLUMN_WIDTH = 296;
const COLUMN_GAP = 12;

function addButtonStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.addButton, (hovered || pressed) && styles.addButtonHovered];
}

/**
 * Scrollable kanban board: four horizontally scrollable columns with a
 * "move to…" menu on each card. This is the committed shape for touch —
 * native and compact web — where pointer drag is unreliable; the desktop web
 * board (kanban-board.web.tsx) layers dnd-kit drag on top instead.
 */
export function ScrollableKanbanBoard({
  board,
  folderId,
  onMoveTask,
  onPressTask,
  onAddTask,
  onRunTask,
  onReanalyzeTask,
  onDeleteTask,
  columnExtras,
}: KanbanBoardProps) {
  const labels = useColumnLabels();
  const isCompact = useIsCompactFormFactor();
  const [controls, setControls] = useState<ColumnControlsMap>({});
  const setColumnControls = useCallback((column: TaskColumn, next: ColumnControls) => {
    setControls((prev) => ({ ...prev, [column]: next }));
  }, []);
  const columns = useMemo(
    () => buildColumnModels(board, folderId, controls),
    [board, folderId, controls],
  );

  return (
    // Board padding/gap live on an inner View, NOT on contentContainerStyle —
    // Unistyles styles passed to contentContainerStyle are dropped on web
    // (docs/unistyles.md, "Main Gotcha: contentContainerStyle").
    <ScrollView
      horizontal
      style={styles.boardScroll}
      showsHorizontalScrollIndicator={false}
      snapToInterval={isCompact ? COLUMN_WIDTH + COLUMN_GAP : undefined}
      decelerationRate={isCompact ? "fast" : undefined}
    >
      <View style={styles.boardContent}>
        {columns.map(({ column, tasks }) => (
          <BoardColumn
            key={column}
            board={board}
            folderId={folderId}
            column={column}
            label={labels[column]}
            labels={labels}
            tasks={tasks}
            controls={controls[column] ?? EMPTY_COLUMN_CONTROLS}
            onControlsChange={setColumnControls}
            extras={columnExtras?.column === column ? columnExtras.node : null}
            onMoveTask={onMoveTask}
            onPressTask={onPressTask}
            onAddTask={onAddTask}
            onRunTask={onRunTask}
            onReanalyzeTask={onReanalyzeTask}
            onDeleteTask={onDeleteTask}
          />
        ))}
      </View>
    </ScrollView>
  );
}

const BoardColumn = memo(function BoardColumn({
  // `board` / `folderId` stay in the props type (the parent still spreads them)
  // but the column stopped reading them when "Lancer maintenant" moved to the
  // task detail — destructuring them here would just be an unused binding.
  column,
  label,
  labels,
  tasks,
  controls,
  onControlsChange,
  extras,
  onMoveTask,
  onPressTask,
  onAddTask,
  onRunTask,
  onReanalyzeTask,
  onDeleteTask,
}: {
  board: TaskBoard | null;
  folderId: string;
  column: TaskColumn;
  label: string;
  labels: Record<TaskColumn, string>;
  tasks: KanbanTask[];
  controls: ColumnControls;
  onControlsChange: (column: TaskColumn, next: ColumnControls) => void;
  extras: React.ReactNode;
  onMoveTask: KanbanBoardProps["onMoveTask"];
  onPressTask: KanbanBoardProps["onPressTask"];
  onAddTask: KanbanBoardProps["onAddTask"];
  onRunTask: KanbanBoardProps["onRunTask"];
  onReanalyzeTask: KanbanBoardProps["onReanalyzeTask"];
  onDeleteTask: KanbanBoardProps["onDeleteTask"];
}) {
  const { t } = useTranslation();
  const handleAddTask = useCallback(() => {
    onAddTask(column);
  }, [onAddTask, column]);
  // "Send all to À faire": promote every draft note into the backlog at once, so
  // a batch of captured ideas enters the normal cycle in one tap.
  const handlePromoteAll = useCallback(() => {
    for (const task of tasks) {
      onMoveTask({ taskId: task.id, column: "backlog", index: Number.MAX_SAFE_INTEGER });
    }
  }, [tasks, onMoveTask]);
  const handleControlsChange = useCallback(
    (next: ColumnControls) => onControlsChange(column, next),
    [onControlsChange, column],
  );

  return (
    <View style={styles.column}>
      <View style={styles.columnHeader}>
        <ColumnStatusDot column={column} />
        <Text style={styles.columnTitle}>{label}</Text>
        <Text style={styles.columnCount}>{tasks.length}</Text>
        <View style={styles.columnHeaderSpacer} />
        {/* Notes-only: promote every draft to "À faire" in one tap. */}
        {column === "notes" && tasks.length > 0 ? (
          <Pressable
            onPress={handlePromoteAll}
            style={addButtonStyle}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t("tasks.actions.moveToColumn", { column: labels.backlog })}
            testID="tasks-notes-promote-all"
          >
            <ThemedChevronsRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          </Pressable>
        ) : null}
        {/* Inline add is limited to the two entry columns: "notes" (draft capture)
            and "backlog" ("À faire"). Everything else flows in by drag or pipeline,
            so those columns get no "+". */}
        {column === "backlog" || column === "notes" ? (
          <Pressable
            onPress={handleAddTask}
            style={addButtonStyle}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t(
              column === "notes" ? "tasks.notes.addNote" : "tasks.actions.addTask",
            )}
            testID={`tasks-add-${column}`}
          >
            <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          </Pressable>
        ) : null}
      </View>
      <BoardColumnToolbar column={column} controls={controls} onChange={handleControlsChange} />
      <ScrollView style={styles.columnScroll} showsVerticalScrollIndicator={false}>
        <View style={styles.columnContent}>
          {extras}
          {tasks.map((task) => (
            <BoardCardRow
              key={task.id}
              task={task}
              labels={labels}
              onMoveTask={onMoveTask}
              onPressTask={onPressTask}
              onRunTask={onRunTask}
              onReanalyzeTask={onReanalyzeTask}
              onDeleteTask={onDeleteTask}
            />
          ))}
          {tasks.length === 0 && !extras ? (
            <Text style={styles.emptyColumnText}>{t("tasks.board.emptyColumn")}</Text>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
});

// Small semantic dot in the column header, like the colored markers on the
// board's reference designs: quiet for the backlog, blue for planned, amber for
// running, green for done.
const ColumnStatusDot = memo(function ColumnStatusDot({ column }: { column: TaskColumn }) {
  const dotStyle = useMemo(
    () => [
      styles.columnDot,
      column === "validated" && styles.columnDotValidated,
      column === "scheduled" && styles.columnDotScheduled,
      column === "in_progress" && styles.columnDotInProgress,
      column === "done" && styles.columnDotDone,
      column === "deployed" && styles.columnDotDeployed,
    ],
    [column],
  );
  return <View style={dotStyle} />;
});

const BoardCardRow = memo(function BoardCardRow({
  task,
  labels,
  onMoveTask,
  onPressTask,
  onRunTask,
  onReanalyzeTask,
  onDeleteTask,
}: {
  task: KanbanTask;
  labels: Record<TaskColumn, string>;
  onMoveTask: KanbanBoardProps["onMoveTask"];
  onPressTask: KanbanBoardProps["onPressTask"];
  onRunTask: KanbanBoardProps["onRunTask"];
  onReanalyzeTask: KanbanBoardProps["onReanalyzeTask"];
  onDeleteTask: KanbanBoardProps["onDeleteTask"];
}) {
  return (
    <View style={styles.cardRow}>
      <TaskCard task={task} onPress={onPressTask} testID={`tasks-card-${task.id}`} />
      <View style={styles.moveTriggerOverlay}>
        <TaskCardMenu
          task={task}
          labels={labels}
          onMoveTask={onMoveTask}
          onRunTask={onRunTask}
          onReanalyzeTask={onReanalyzeTask}
          onDeleteTask={onDeleteTask}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  boardScroll: {
    flex: 1,
  },
  boardContent: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
    gap: COLUMN_GAP,
  },
  // Flat neutral container: no border, big radius, light-gray surface to match
  // the Paseo zinc palette (cards sit on top as white/surface0 tickets).
  column: {
    width: COLUMN_WIDTH,
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  columnHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  columnHeaderSpacer: {
    flex: 1,
  },
  columnDot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  columnDotValidated: {
    backgroundColor: theme.colors.palette.purple[500],
  },
  columnDotScheduled: {
    backgroundColor: theme.colors.palette.blue[500],
  },
  columnDotInProgress: {
    backgroundColor: theme.colors.statusWarning,
  },
  columnDotDone: {
    backgroundColor: theme.colors.statusSuccess,
  },
  columnDotDeployed: {
    backgroundColor: theme.colors.palette.teal[500],
  },
  columnTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  columnCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  addButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  addButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  columnScroll: {
    flex: 1,
  },
  columnContent: {
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  cardRow: {
    position: "relative",
  },
  moveTriggerOverlay: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[2],
  },
  emptyColumnText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
    paddingVertical: theme.spacing[8],
  },
}));

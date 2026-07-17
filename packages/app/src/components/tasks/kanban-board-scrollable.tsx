import { memo, useCallback, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ArrowRight, Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { KanbanTask, TaskColumn } from "@/data/tasks";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { TaskCard } from "./task-card";
import {
  buildColumnModels,
  KANBAN_COLUMNS,
  useColumnLabels,
  type KanbanBoardProps,
} from "./kanban-columns";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedPlus = withUnistyles(Plus);
const ThemedArrowRight = withUnistyles(ArrowRight);

// Shared by the board row styles and the compact snap interval — keep in sync.
const COLUMN_WIDTH = 280;
const COLUMN_GAP = 12;

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
  columnExtras,
}: KanbanBoardProps) {
  const labels = useColumnLabels();
  const isCompact = useIsCompactFormFactor();
  const columns = useMemo(() => buildColumnModels(board, folderId), [board, folderId]);

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
            column={column}
            label={labels[column]}
            labels={labels}
            tasks={tasks}
            extras={columnExtras?.column === column ? columnExtras.node : null}
            onMoveTask={onMoveTask}
            onPressTask={onPressTask}
            onAddTask={onAddTask}
          />
        ))}
      </View>
    </ScrollView>
  );
}

const BoardColumn = memo(function BoardColumn({
  column,
  label,
  labels,
  tasks,
  extras,
  onMoveTask,
  onPressTask,
  onAddTask,
}: {
  column: TaskColumn;
  label: string;
  labels: Record<TaskColumn, string>;
  tasks: KanbanTask[];
  extras: React.ReactNode;
  onMoveTask: KanbanBoardProps["onMoveTask"];
  onPressTask: KanbanBoardProps["onPressTask"];
  onAddTask: KanbanBoardProps["onAddTask"];
}) {
  const { t } = useTranslation();
  const handleAddTask = useCallback(() => {
    onAddTask(column);
  }, [onAddTask, column]);

  return (
    <View style={styles.column}>
      <View style={styles.columnHeader}>
        <Text style={styles.columnTitle}>{label}</Text>
        <Text style={styles.columnCount}>{tasks.length}</Text>
        <View style={styles.columnHeaderSpacer} />
        <Pressable
          onPress={handleAddTask}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.actions.addTask")}
          testID={`tasks-add-${column}`}
        >
          <ThemedPlus size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </Pressable>
      </View>
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

const BoardCardRow = memo(function BoardCardRow({
  task,
  labels,
  onMoveTask,
  onPressTask,
}: {
  task: KanbanTask;
  labels: Record<TaskColumn, string>;
  onMoveTask: KanbanBoardProps["onMoveTask"];
  onPressTask: KanbanBoardProps["onPressTask"];
}) {
  return (
    <View style={styles.cardRow}>
      <TaskCard task={task} onPress={onPressTask} testID={`tasks-card-${task.id}`} />
      <MoveTaskMenu task={task} labels={labels} onMoveTask={onMoveTask} />
    </View>
  );
});

function renderMoveTrigger() {
  return <ThemedArrowRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
}

const MoveTaskMenu = memo(function MoveTaskMenu({
  task,
  labels,
  onMoveTask,
}: {
  task: KanbanTask;
  labels: Record<TaskColumn, string>;
  onMoveTask: KanbanBoardProps["onMoveTask"];
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.moveTrigger}
        accessibilityRole="button"
        accessibilityLabel={t("tasks.actions.moveTo")}
        testID={`tasks-move-${task.id}`}
      >
        {renderMoveTrigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end" offset={4} width={200}>
        {KANBAN_COLUMNS.filter((column) => column !== task.column).map((column) => (
          <MoveTaskMenuItem
            key={column}
            taskId={task.id}
            column={column}
            label={t("tasks.actions.moveToColumn", { column: labels[column] })}
            onMoveTask={onMoveTask}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const MoveTaskMenuItem = memo(function MoveTaskMenuItem({
  taskId,
  column,
  label,
  onMoveTask,
}: {
  taskId: string;
  column: TaskColumn;
  label: string;
  onMoveTask: KanbanBoardProps["onMoveTask"];
}) {
  const handleSelect = useCallback(() => {
    onMoveTask({ taskId, column, index: Number.MAX_SAFE_INTEGER });
  }, [onMoveTask, taskId, column]);
  return <DropdownMenuItem onSelect={handleSelect}>{label}</DropdownMenuItem>;
});

const styles = StyleSheet.create((theme) => ({
  boardScroll: {
    flex: 1,
  },
  boardContent: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[4],
    gap: COLUMN_GAP,
  },
  column: {
    width: COLUMN_WIDTH,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  columnHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  columnHeaderSpacer: {
    flex: 1,
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
  columnScroll: {
    flex: 1,
  },
  columnContent: {
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  cardRow: {
    gap: theme.spacing[1],
  },
  moveTrigger: {
    alignSelf: "flex-end",
    padding: theme.spacing[1],
  },
  emptyColumnText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
    paddingVertical: theme.spacing[4],
  },
}));

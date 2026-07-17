import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { KanbanTask, TaskColumn } from "@/data/tasks";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { ScrollableKanbanBoard } from "./kanban-board-scrollable";
import { TaskCard } from "./task-card";
import { buildColumnModels, useColumnLabels, type KanbanBoardProps } from "./kanban-columns";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedPlus = withUnistyles(Plus);

const COLUMN_DROPPABLE_PREFIX = "column:";
const POINTER_ACTIVATION = { activationConstraint: { distance: 6 } };

function noopPressTask() {}

/**
 * Web kanban board. Compact (phone-sized) web uses the shared scrollable
 * board — dnd-kit's touch drag (touchAction: none) would swallow column and
 * board scrolling on touch screens. Desktop web gets multi-container
 * drag-and-drop via dnd-kit: the drop target (column + index) is resolved at
 * drag end and sent as a single tasks.task.move RPC; the server push then
 * snaps the authoritative order.
 */
export function KanbanBoard(props: KanbanBoardProps) {
  const isCompact = useIsCompactFormFactor();
  if (isCompact) {
    return <ScrollableKanbanBoard {...props} />;
  }
  return <DesktopKanbanBoard {...props} />;
}

function DesktopKanbanBoard({
  board,
  folderId,
  onMoveTask,
  onPressTask,
  onAddTask,
  columnExtras,
}: KanbanBoardProps) {
  const labels = useColumnLabels();
  const columns = useMemo(() => buildColumnModels(board, folderId), [board, folderId]);
  const [activeTask, setActiveTask] = useState<KanbanTask | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, POINTER_ACTIVATION));

  const tasksById = useMemo(() => {
    const map = new Map<string, KanbanTask>();
    for (const { tasks } of columns) {
      for (const task of tasks) {
        map.set(task.id, task);
      }
    }
    return map;
  }, [columns]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      setActiveTask(tasksById.get(String(event.active.id)) ?? null);
    },
    [tasksById],
  );

  const handleDragCancel = useCallback(() => {
    setActiveTask(null);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveTask(null);
      const { active, over } = event;
      if (!over) {
        return;
      }
      const taskId = String(active.id);
      const overId = String(over.id);
      let targetColumn: TaskColumn | null = null;
      let targetIndex = 0;
      if (overId.startsWith(COLUMN_DROPPABLE_PREFIX)) {
        targetColumn = overId.slice(COLUMN_DROPPABLE_PREFIX.length) as TaskColumn;
        targetIndex = columns.find((entry) => entry.column === targetColumn)?.tasks.length ?? 0;
      } else {
        const overTask = tasksById.get(overId);
        if (!overTask) {
          return;
        }
        targetColumn = overTask.column;
        const columnTasks = columns.find((entry) => entry.column === targetColumn)?.tasks ?? [];
        targetIndex = columnTasks.findIndex((entry) => entry.id === overId);
        if (targetIndex < 0) {
          targetIndex = columnTasks.length;
        }
      }
      const task = tasksById.get(taskId);
      if (!task || !targetColumn) {
        return;
      }
      if (task.column === targetColumn && overId === taskId) {
        return;
      }
      onMoveTask({ taskId, column: targetColumn, index: targetIndex });
    },
    [columns, onMoveTask, tasksById],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <View style={styles.boardRow}>
        {columns.map(({ column, tasks }) => (
          <DroppableColumn
            key={column}
            column={column}
            label={labels[column]}
            tasks={tasks}
            extras={columnExtras?.column === column ? columnExtras.node : null}
            onAddTask={onAddTask}
            onPressTask={onPressTask}
          />
        ))}
      </View>
      <DragOverlay>
        {activeTask ? (
          <View style={styles.dragOverlayCard}>
            <TaskCard task={activeTask} onPress={noopPressTask} />
          </View>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

const DroppableColumn = memo(function DroppableColumn({
  column,
  label,
  tasks,
  extras,
  onAddTask,
  onPressTask,
}: {
  column: TaskColumn;
  label: string;
  tasks: KanbanTask[];
  extras: React.ReactNode;
  onAddTask: KanbanBoardProps["onAddTask"];
  onPressTask: KanbanBoardProps["onPressTask"];
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_DROPPABLE_PREFIX}${column}` });
  const columnStyle = useMemo(() => [styles.column, isOver && styles.columnOver], [isOver]);
  const sortableItems = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const handleAddTask = useCallback(() => {
    onAddTask(column);
  }, [onAddTask, column]);

  return (
    <View style={columnStyle}>
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
      <div ref={setNodeRef} style={webColumnBodyStyle}>
        {extras}
        <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <SortableTaskCard key={task.id} task={task} onPressTask={onPressTask} />
          ))}
        </SortableContext>
        {tasks.length === 0 && !extras ? (
          <Text style={styles.emptyColumnText}>{t("tasks.board.emptyColumn")}</Text>
        ) : null}
      </div>
    </View>
  );
});

const SortableTaskCard = memo(function SortableTaskCard({
  task,
  onPressTask,
}: {
  task: KanbanTask;
  onPressTask: (task: KanbanTask) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  const wrapperStyle = useMemo(
    (): React.CSSProperties => ({
      transform: CSS.Transform.toString(transform),
      transition: transition ?? undefined,
      opacity: isDragging ? 0.4 : 1,
      cursor: "grab",
      touchAction: "none",
    }),
    [transform, transition, isDragging],
  );
  return (
    // touchAction none is required for PointerSensor drags on touch devices,
    // and RNW's Pressable inside must not own the pointerdown, so listeners
    // live on this wrapper.
    <div
      ref={setNodeRef}
      style={wrapperStyle}
      {...attributes}
      {...listeners}
      data-testid={`tasks-drag-${task.id}`}
    >
      <TaskCard task={task} onPress={onPressTask} testID={`tasks-card-${task.id}`} />
    </div>
  );
});

const webColumnBodyStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 8,
  flex: 1,
  minHeight: 120,
  overflowY: "auto",
};

const styles = StyleSheet.create((theme) => ({
  boardRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[4],
  },
  column: {
    flex: 1,
    minWidth: 220,
    maxWidth: 360,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  columnOver: {
    borderColor: theme.colors.foregroundMuted,
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
  dragOverlayCard: {
    width: 260,
    opacity: 0.95,
  },
  emptyColumnText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
    paddingVertical: theme.spacing[4],
  },
}));

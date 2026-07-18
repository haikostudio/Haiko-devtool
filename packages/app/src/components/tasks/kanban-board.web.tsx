import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  closestCorners,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
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
import { TaskCard } from "./task-card";
import {
  buildColumnModels,
  KANBAN_COLUMN_MAX_WIDTH,
  useColumnLabels,
  type KanbanBoardProps,
} from "./kanban-columns";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedPlus = withUnistyles(Plus);

const COLUMN_DROPPABLE_PREFIX = "column:";
// Desktop: drag starts after a small pointer travel so plain clicks still
// open the card. Touch: long-press (Trello-style) lifts the card while quick
// pans keep scrolling the board/columns.
const MOUSE_ACTIVATION = { activationConstraint: { distance: 6 } };
const TOUCH_ACTIVATION = { activationConstraint: { delay: 250, tolerance: 8 } };

function noopPressTask() {}

// Multi-container collision strategy (dnd-kit's documented pattern): prefer
// whatever droppable the pointer is inside, then rect overlap. Bare
// closestCorners is a trap here — the small source card's corners stay
// "closer" than the huge target column's, so cross-column drops resolve back
// to the dragged card itself and no move fires.
const collideByPointerFirst: CollisionDetection = (args) => {
  const withPointer = pointerWithin(args);
  if (withPointer.length > 0) {
    return withPointer;
  }
  const byRect = rectIntersection(args);
  if (byRect.length > 0) {
    return byRect;
  }
  return closestCorners(args);
};

/**
 * Web kanban board: multi-container drag-and-drop via dnd-kit on every form
 * factor. The columns row lives in a horizontally scrollable container
 * (fixed-width columns on compact, flexing columns on desktop); dnd-kit's
 * auto-scroll handles dragging across off-screen columns. The drop target
 * (column + index) is resolved at drag end and sent as a single
 * tasks.task.move RPC; the server push then snaps the authoritative order.
 */
export function KanbanBoard({
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
  const [activeTask, setActiveTask] = useState<KanbanTask | null>(null);

  const sensors = useSensors(
    useSensor(MouseSensor, MOUSE_ACTIVATION),
    useSensor(TouchSensor, TOUCH_ACTIVATION),
  );

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
      collisionDetection={collideByPointerFirst}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div style={boardScrollStyle}>
        <View style={styles.boardRow}>
          {columns.map(({ column, tasks }) => (
            <DroppableColumn
              key={column}
              column={column}
              label={labels[column]}
              tasks={tasks}
              compact={isCompact}
              extras={columnExtras?.column === column ? columnExtras.node : null}
              onAddTask={onAddTask}
              onPressTask={onPressTask}
            />
          ))}
        </View>
      </div>
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
  compact,
  extras,
  onAddTask,
  onPressTask,
}: {
  column: TaskColumn;
  label: string;
  tasks: KanbanTask[];
  compact: boolean;
  extras: React.ReactNode;
  onAddTask: KanbanBoardProps["onAddTask"];
  onPressTask: KanbanBoardProps["onPressTask"];
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: `${COLUMN_DROPPABLE_PREFIX}${column}` });
  const columnStyle = useMemo(
    () => [
      styles.column,
      compact ? styles.columnCompact : styles.columnDesktop,
      isOver && styles.columnOver,
    ],
    [compact, isOver],
  );
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
      // TaskCard renders as a real <button>, and button width:auto is
      // shrink-to-fit in some engines (Safari) — force the card to fill the
      // column by making this wrapper a stretching flex column.
      display: "flex",
      flexDirection: "column",
      alignItems: "stretch",
      // "manipulation" (NOT "none") keeps touch scrolling alive; the
      // TouchSensor's long-press activation takes over pointer ownership only
      // once a drag actually starts. userSelect/touchCallout suppress the iOS
      // long-press text-selection and callout during the hold.
      touchAction: "manipulation",
      userSelect: "none",
      WebkitUserSelect: "none",
      WebkitTouchCallout: "none",
    }),
    [transform, transition, isDragging],
  );
  return (
    // RNW's Pressable inside must not own the pointerdown, so the dnd
    // listeners live on this wrapper.
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

// Horizontal scroll surface for the columns row. A plain div (not an RNW
// ScrollView) so dnd-kit's auto-scroll can drive it while dragging.
const boardScrollStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
  overflowX: "auto",
};

const webColumnBodyStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: 8,
  padding: 8,
  flex: 1,
  minHeight: 120,
  overflowY: "auto",
};

const styles = StyleSheet.create((theme) => ({
  boardRow: {
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[4],
  },
  column: {
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  columnDesktop: {
    flex: 1,
    minWidth: 220,
    maxWidth: KANBAN_COLUMN_MAX_WIDTH,
  },
  columnCompact: {
    width: 280,
    flexShrink: 0,
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

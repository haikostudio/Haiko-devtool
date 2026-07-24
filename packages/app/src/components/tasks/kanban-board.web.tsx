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
import type { KanbanTask, TaskBoard, TaskColumn } from "@/data/tasks";
import { ICON_SIZE, SPACING, type Theme } from "@/styles/theme";
import { TaskCard } from "./task-card";
import { TaskCardMenu } from "./task-card-menu";
import { BoardColumnToolbar } from "./kanban-column-toolbar";
import {
  buildColumnModels,
  EMPTY_COLUMN_CONTROLS,
  KANBAN_COLUMN_MAX_WIDTH,
  useColumnLabels,
  type ColumnControls,
  type ColumnControlsMap,
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
  onRunTask,
  onReanalyzeTask,
  columnExtras,
}: KanbanBoardProps) {
  const labels = useColumnLabels();
  const isCompact = useIsCompactFormFactor();
  const [controls, setControls] = useState<ColumnControlsMap>({});
  const setColumnControls = useCallback((column: TaskColumn, next: ColumnControls) => {
    setControls((prev) => ({ ...prev, [column]: next }));
  }, []);
  // A hand-drag within a column pins that column to the arranged order for the
  // session, so the recency sort stops yanking the just-moved card back to the
  // top. Idempotent: leaves the map untouched once the column is already manual.
  const markColumnManual = useCallback((column: TaskColumn) => {
    setControls((prev) => {
      const current = prev[column] ?? EMPTY_COLUMN_CONTROLS;
      if (current.manualOrder) {
        return prev;
      }
      return { ...prev, [column]: { ...current, manualOrder: true } };
    });
  }, []);
  const columns = useMemo(
    () => buildColumnModels(board, folderId, controls),
    [board, folderId, controls],
  );
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
      // A reorder within the same column is a manual arrangement — pin it so the
      // card stays where it was dropped instead of snapping back by recency.
      if (task.column === targetColumn) {
        markColumnManual(targetColumn);
      }
      onMoveTask({ taskId, column: targetColumn, index: targetIndex });
    },
    [columns, markColumnManual, onMoveTask, tasksById],
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
        <View style={isCompact ? styles.boardRowCompact : styles.boardRow}>
          {columns.map(({ column, tasks }) => (
            <DroppableColumn
              key={column}
              board={board}
              folderId={folderId}
              column={column}
              label={labels[column]}
              labels={labels}
              tasks={tasks}
              compact={isCompact}
              controls={controls[column] ?? EMPTY_COLUMN_CONTROLS}
              onControlsChange={setColumnControls}
              extras={columnExtras?.column === column ? columnExtras.node : null}
              onAddTask={onAddTask}
              onPressTask={onPressTask}
              onMoveTask={onMoveTask}
              onRunTask={onRunTask}
              onReanalyzeTask={onReanalyzeTask}
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
  board,
  folderId,
  column,
  label,
  labels,
  tasks,
  compact,
  controls,
  onControlsChange,
  extras,
  onAddTask,
  onPressTask,
  onMoveTask,
  onRunTask,
  onReanalyzeTask,
}: {
  board: TaskBoard | null;
  folderId: string;
  column: TaskColumn;
  label: string;
  labels: Record<TaskColumn, string>;
  tasks: KanbanTask[];
  compact: boolean;
  controls: ColumnControls;
  onControlsChange: (column: TaskColumn, next: ColumnControls) => void;
  extras: React.ReactNode;
  onAddTask: KanbanBoardProps["onAddTask"];
  onPressTask: KanbanBoardProps["onPressTask"];
  onMoveTask: KanbanBoardProps["onMoveTask"];
  onRunTask: KanbanBoardProps["onRunTask"];
  onReanalyzeTask: KanbanBoardProps["onReanalyzeTask"];
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
  const handleControlsChange = useCallback(
    (next: ColumnControls) => onControlsChange(column, next),
    [onControlsChange, column],
  );

  return (
    <View style={columnStyle}>
      <View style={styles.columnHeader}>
        <ColumnStatusDot column={column} />
        <Text style={styles.columnTitle}>{label}</Text>
        <Text style={styles.columnCount}>{tasks.length}</Text>
        <View style={styles.columnHeaderSpacer} />
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
      <BoardColumnToolbar
        board={board}
        folderId={folderId}
        column={column}
        controls={controls}
        onChange={handleControlsChange}
      />
      <div ref={setNodeRef} style={webColumnBodyStyle}>
        {extras}
        <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <SortableTaskCard
              key={task.id}
              task={task}
              labels={labels}
              onPressTask={onPressTask}
              onMoveTask={onMoveTask}
              onRunTask={onRunTask}
              onReanalyzeTask={onReanalyzeTask}
            />
          ))}
        </SortableContext>
        {tasks.length === 0 && !extras ? (
          <Text style={styles.emptyColumnText}>{t("tasks.board.emptyColumn")}</Text>
        ) : null}
      </div>
    </View>
  );
});

// Small semantic dot in the column header: quiet for the backlog, blue for
// planned, amber for running, green for done. Mirrors the scrollable board.
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

function addButtonStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.addButton, (hovered || pressed) && styles.addButtonHovered];
}

const SortableTaskCard = memo(function SortableTaskCard({
  task,
  labels,
  onPressTask,
  onMoveTask,
  onRunTask,
  onReanalyzeTask,
}: {
  task: KanbanTask;
  labels: Record<TaskColumn, string>;
  onPressTask: (task: KanbanTask) => void;
  onMoveTask: KanbanBoardProps["onMoveTask"];
  onRunTask: KanbanBoardProps["onRunTask"];
  onReanalyzeTask: KanbanBoardProps["onReanalyzeTask"];
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
      // Anchor for the absolutely-positioned overflow-menu overlay below.
      position: "relative",
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
      {/* Overflow menu overlay: swallow the drag-start pointer/mouse/touch so
          opening the menu never lifts the card into a drag. */}
      <div
        style={cardMenuOverlayStyle}
        onPointerDown={stopDragActivation}
        onMouseDown={stopDragActivation}
        onTouchStart={stopDragActivation}
      >
        <TaskCardMenu
          task={task}
          labels={labels}
          onMoveTask={onMoveTask}
          onRunTask={onRunTask}
          onReanalyzeTask={onReanalyzeTask}
        />
      </div>
    </div>
  );
});

function stopDragActivation(event: React.SyntheticEvent) {
  event.stopPropagation();
}

const cardMenuOverlayStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  zIndex: 2,
};

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
  gap: SPACING[2],
  padding: SPACING[2],
  flex: 1,
  minHeight: 120,
  overflowY: "auto",
};

const styles = StyleSheet.create((theme) => ({
  boardRow: {
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "center",
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  // Compact: tighter gap and inset so the board reclaims horizontal space and
  // its left edge lines up with the tab switch and back row above.
  boardRowCompact: {
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  // Flat neutral container: no border, big radius, light-gray surface to match
  // the Paseo zinc palette (cards sit on top as white/surface0 tickets).
  column: {
    borderRadius: theme.borderRadius["2xl"],
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  columnDesktop: {
    flex: 1,
    minWidth: 240,
    maxWidth: KANBAN_COLUMN_MAX_WIDTH,
  },
  columnCompact: {
    width: 300,
    flexShrink: 0,
  },
  // Drop target: an inset ring instead of a border so the layout never shifts.
  // Web-only file, so boxShadow is safe.
  columnOver: {
    boxShadow: `inset 0 0 0 2px ${theme.colors.foregroundMuted}`,
  },
  columnHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
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
  dragOverlayCard: {
    width: 280,
    opacity: 0.95,
  },
  emptyColumnText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
    paddingVertical: theme.spacing[8],
  },
}));

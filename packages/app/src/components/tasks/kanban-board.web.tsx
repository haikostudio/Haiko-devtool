import { memo, useCallback, useEffect, useMemo, useState } from "react";
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
import { ChevronsRight, Plus } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { KanbanTask, TaskBoard, TaskColumn } from "@/data/tasks";
import { ICON_SIZE, SPACING, type Theme } from "@/styles/theme";
import { TaskCard } from "./task-card";
import { TaskCardMenu } from "./task-card-menu";
import { TaskCardStack, useBatchExpansion, type RenderCardOptions } from "./task-card-stack";
import { createPressSlopTracker } from "./card-press-slop";
import { groupTasksIntoBoardRows, visibleTaskIds } from "./task-batch-grouping";
import { BoardColumnToolbar } from "./kanban-column-toolbar";
import { DeployControl } from "./deploy-control";
import { ArchiveSelectionControls } from "./archive-selection-controls";
import { useDeployArchiveSelection, type ArchiveSelectionColumnProps } from "./archive-selection";
import { logRefusedMove } from "./board-move-log";
import { isTaskMoveAllowed } from "./task-move-guard";
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
const ThemedChevronsRight = withUnistyles(ChevronsRight);

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
  onMoveTask,
  onPressTask,
  onAddTask,
  onRunTask,
  onReanalyzeTask,
  onDeleteTask,
  onDeployAll,
  onOpenDeployLog,
  onResetDeploy,
  onStopDeploy,
  onToggleDeployHold,
  deployOffPeak,
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
  const columns = useMemo(() => buildColumnModels(board, controls), [board, controls]);
  const archiveSelection = useDeployArchiveSelection(columns, onMoveTask);
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
      // "Archivé" is the terminal resting column: its cards are frozen and never
      // dragged back out. Dropping a card INTO it is a manual archive — allowed,
      // and gated like any other move by isTaskMoveAllowed below.
      if (task.column === "archived") {
        return;
      }
      if (task.column === targetColumn && overId === taskId) {
        return;
      }
      // Work in flight never walks backward. Refused here, at the drop, so the
      // card snaps straight back instead of flashing through the forbidden
      // column, and so a rejected gesture never pins the column to manual order.
      if (!isTaskMoveAllowed(task, targetColumn)) {
        logRefusedMove(task, targetColumn, "drag");
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
              column={column}
              label={labels[column]}
              labels={labels}
              tasks={tasks}
              compact={isCompact}
              controls={controls[column] ?? EMPTY_COLUMN_CONTROLS}
              onControlsChange={setColumnControls}
              archiveSelection={column === "deployed" ? archiveSelection : undefined}
              extras={columnExtras?.column === column ? columnExtras.node : null}
              onAddTask={onAddTask}
              onPressTask={onPressTask}
              onMoveTask={onMoveTask}
              onRunTask={onRunTask}
              onReanalyzeTask={onReanalyzeTask}
              onDeleteTask={onDeleteTask}
              onDeployAll={onDeployAll}
              onOpenDeployLog={onOpenDeployLog}
              onResetDeploy={onResetDeploy}
              onStopDeploy={onStopDeploy}
              onToggleDeployHold={onToggleDeployHold}
              deployOffPeak={deployOffPeak}
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
  column,
  label,
  labels,
  tasks,
  compact,
  controls,
  onControlsChange,
  archiveSelection,
  extras,
  onAddTask,
  onPressTask,
  onMoveTask,
  onRunTask,
  onReanalyzeTask,
  onDeleteTask,
  onDeployAll,
  onOpenDeployLog,
  onResetDeploy,
  onStopDeploy,
  onToggleDeployHold,
  deployOffPeak,
}: {
  board: TaskBoard | null;
  column: TaskColumn;
  label: string;
  labels: Record<TaskColumn, string>;
  tasks: KanbanTask[];
  compact: boolean;
  controls: ColumnControls;
  onControlsChange: (column: TaskColumn, next: ColumnControls) => void;
  archiveSelection: ArchiveSelectionColumnProps | undefined;
  extras: React.ReactNode;
  onAddTask: KanbanBoardProps["onAddTask"];
  onPressTask: KanbanBoardProps["onPressTask"];
  onMoveTask: KanbanBoardProps["onMoveTask"];
  onRunTask: KanbanBoardProps["onRunTask"];
  onReanalyzeTask: KanbanBoardProps["onReanalyzeTask"];
  onDeleteTask: KanbanBoardProps["onDeleteTask"];
  onDeployAll: KanbanBoardProps["onDeployAll"];
  onOpenDeployLog: KanbanBoardProps["onOpenDeployLog"];
  onResetDeploy: KanbanBoardProps["onResetDeploy"];
  onStopDeploy: KanbanBoardProps["onStopDeploy"];
  onToggleDeployHold: KanbanBoardProps["onToggleDeployHold"];
  deployOffPeak: KanbanBoardProps["deployOffPeak"];
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
  // Cards of one lot ("N sur M", shared lot tag) collapse into a single pile —
  // see task-batch-grouping.ts. A collapsed pile only mounts its lead card, so
  // dnd-kit must only ever know about the ids actually on screen: a folded-away
  // card that stayed in `items` would swallow drops into a hole in the column.
  const { isExpanded, toggleExpanded } = useBatchExpansion();
  const rows = useMemo(() => groupTasksIntoBoardRows(tasks), [tasks]);
  const sortableItems = useMemo(() => visibleTaskIds(rows, isExpanded), [rows, isExpanded]);
  const handleAddTask = useCallback(() => {
    onAddTask(column);
  }, [onAddTask, column]);
  // "Send all to À faire": promote every draft note into the backlog at once.
  const handlePromoteAll = useCallback(() => {
    for (const task of tasks) {
      onMoveTask({ taskId: task.id, column: "backlog", index: Number.MAX_SAFE_INTEGER });
    }
  }, [tasks, onMoveTask]);
  const handleControlsChange = useCallback(
    (next: ColumnControls) => onControlsChange(column, next),
    [onControlsChange, column],
  );
  const renderCard = useCallback(
    (task: KanbanTask, options?: RenderCardOptions) => (
      <SortableTaskCard
        task={task}
        labels={labels}
        onPressTask={options?.onPress ?? onPressTask}
        accessibilityLabel={options?.accessibilityLabel}
        onMoveTask={onMoveTask}
        onRunTask={onRunTask}
        onReanalyzeTask={onReanalyzeTask}
        onDeleteTask={onDeleteTask}
        onToggleDeployHold={onToggleDeployHold}
        selection={archiveSelection}
      />
    ),
    [
      labels,
      onPressTask,
      onMoveTask,
      onRunTask,
      onReanalyzeTask,
      onDeleteTask,
      onToggleDeployHold,
      archiveSelection,
    ],
  );

  return (
    <View style={columnStyle}>
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
      {/* One control at the column head that morphs in place: the "Tout déployer"
          button at rest, the run's progress bar while it publishes, then its
          recap — never two stacked blocks about the same publication. */}
      <DeployControl
        column={column}
        tasks={tasks}
        batch={board?.deployBatch ?? null}
        onDeployAll={onDeployAll}
        offPeakEnabled={deployOffPeak?.enabled}
        onToggleOffPeak={deployOffPeak?.onToggle}
        onOpenLog={onOpenDeployLog}
        onReset={onResetDeploy}
        onStop={onStopDeploy}
      />
      <div ref={setNodeRef} style={webColumnBodyStyle}>
        {extras}
        <SortableContext items={sortableItems} strategy={verticalListSortingStrategy}>
          {rows.map((row) =>
            row.kind === "task" ? (
              <SortableTaskCard
                key={row.key}
                task={row.task}
                labels={labels}
                onPressTask={onPressTask}
                onMoveTask={onMoveTask}
                onRunTask={onRunTask}
                onReanalyzeTask={onReanalyzeTask}
                onDeleteTask={onDeleteTask}
                onToggleDeployHold={onToggleDeployHold}
                selection={archiveSelection}
              />
            ) : (
              <TaskCardStack
                key={row.key}
                batchKey={row.key}
                tasks={row.tasks}
                expanded={isExpanded(row.key)}
                onToggle={toggleExpanded}
                renderCard={renderCard}
              />
            ),
          )}
        </SortableContext>
        {tasks.length === 0 && !extras ? (
          <Text style={styles.emptyColumnText}>{t("tasks.board.emptyColumn")}</Text>
        ) : null}
      </div>
      {/* Bulk-archive control at the FOOT of "À déployer" (the deploy button owns
          the head). Files checked cards into "Archivé" — a plain move, no build. */}
      <ArchiveSelectionControls
        column={column}
        taskCount={tasks.length}
        selection={archiveSelection}
      />
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
  accessibilityLabel,
  onMoveTask,
  onRunTask,
  onReanalyzeTask,
  onDeleteTask,
  onToggleDeployHold,
  selection,
}: {
  task: KanbanTask;
  labels: Record<TaskColumn, string>;
  onPressTask: (task: KanbanTask) => void;
  accessibilityLabel?: string;
  onMoveTask: KanbanBoardProps["onMoveTask"];
  onRunTask: KanbanBoardProps["onRunTask"];
  onReanalyzeTask: KanbanBoardProps["onReanalyzeTask"];
  onDeleteTask: KanbanBoardProps["onDeleteTask"];
  onToggleDeployHold: KanbanBoardProps["onToggleDeployHold"];
  selection: ArchiveSelectionColumnProps | undefined;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  // "Archivé" cards are frozen: no drag out, no overflow menu. They stay
  // pressable so the user can still open and read them.
  const isArchived = task.column === "archived";
  // Bulk-archive selection mode turns the card into a checkbox: a tap toggles it
  // (TaskCard intercepts the press), so the card must not drag and its ⋮ menu
  // steps aside, exactly like a frozen card but for a different reason.
  const selecting = selection?.active ?? false;
  const cardSelection = useMemo(
    () =>
      selecting
        ? {
            active: true,
            checked: selection?.isSelected(task.id) ?? false,
            onToggle: () => selection?.onToggle(task),
          }
        : undefined,
    [selecting, selection, task],
  );
  // A drag ends on the card it started from, so RNW's press responder would
  // happily read that pointerup as a tap — opening the task, or unfolding the
  // lot the card is the cover of. Capture-phase handlers run before the inner
  // Pressable's, so the verdict is ready by the time onPress fires.
  const slop = useMemo(() => createPressSlopTracker(), []);
  useEffect(() => {
    if (isDragging) {
      slop.markDragging();
    }
  }, [isDragging, slop]);
  const handlePointerDownCapture = useCallback(
    (event: React.PointerEvent) => slop.down(event.clientX, event.clientY),
    [slop],
  );
  const handlePointerUpCapture = useCallback(
    (event: React.PointerEvent) => slop.up(event.clientX, event.clientY),
    [slop],
  );
  const handlePress = useCallback(
    (pressed: KanbanTask) => {
      if (slop.shouldSuppressPress()) {
        return;
      }
      onPressTask(pressed);
    },
    [slop, onPressTask],
  );
  const wrapperStyle = useMemo(
    (): React.CSSProperties => ({
      transform: CSS.Transform.toString(transform),
      transition: transition ?? undefined,
      opacity: isDragging ? 0.4 : 1,
      cursor: isArchived || selecting ? "default" : "grab",
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
    [transform, transition, isDragging, isArchived, selecting],
  );
  // Frozen cards — and cards in selection mode — carry no dnd listeners at all,
  // so a drag never even starts and the tap lands as a checkbox toggle.
  const dragHandlers = isArchived || selecting ? {} : { ...attributes, ...listeners };
  return (
    // RNW's Pressable inside must not own the pointerdown, so the dnd
    // listeners live on this wrapper.
    <div
      ref={setNodeRef}
      style={wrapperStyle}
      {...dragHandlers}
      onPointerDownCapture={handlePointerDownCapture}
      onPointerUpCapture={handlePointerUpCapture}
      data-testid={`tasks-drag-${task.id}`}
    >
      <TaskCard
        task={task}
        onPress={handlePress}
        accessibilityLabel={accessibilityLabel}
        testID={`tasks-card-${task.id}`}
        selection={cardSelection}
      />
      {/* Overflow menu overlay: swallow the drag-start pointer/mouse/touch so
          opening the menu never lifts the card into a drag. Frozen archived
          cards — and cards mid bulk-selection — have no menu, so the overlay is
          dropped entirely. */}
      {isArchived || selecting ? null : (
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
            onDeleteTask={onDeleteTask}
            onToggleDeployHold={onToggleDeployHold}
          />
        </div>
      )}
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
  // minWidth:0 (plus a hard 100% cap) makes this the element that actually
  // absorbs the columns' overflow: it may shrink below their min-content and
  // scroll them internally instead of widening every ancestor up to the page.
  minWidth: 0,
  maxWidth: "100%",
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
  // minWidth:0 lets this flex child shrink to its column instead of being
  // sized by its content — without it a long unbreakable token widens the box.
  minWidth: 0,
  minHeight: 120,
  overflowY: "auto",
  // Cards only scroll vertically. Per the CSS overflow spec, setting one axis to
  // "auto" while the other stays "visible" promotes the visible axis to "auto"
  // too, so any card that overflows would add a stray horizontal scrollbar.
  // Pin the cross axis to "hidden" to keep the column vertical-only.
  overflowX: "hidden",
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

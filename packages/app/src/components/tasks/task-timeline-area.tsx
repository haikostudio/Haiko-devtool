import { useCallback, useMemo, useRef } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { isWeb } from "@/constants/platform";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import type { KanbanTask, TaskBoard } from "@/data/tasks";
import { TaskGantt } from "./task-gantt";

// RN's ViewStyle `cursor` only types auto|pointer; row-resize is web-valid, so
// apply it as a web-only escape hatch outside stricter typing.
const rowResizeCursor: ViewStyle | undefined = isWeb
  ? ({ cursor: "row-resize" } as unknown as ViewStyle)
  : undefined;

/**
 * Floor for the timeline area, so dragging the splitter all the way up still
 * leaves a readable sliver of schedule rather than collapsing it to nothing.
 */
export const MIN_TIMELINE_HEIGHT = 64;

/** Ceiling, so the timeline can never swallow the board entirely. */
const MAX_TIMELINE_HEIGHT = 520;

export const DEFAULT_TIMELINE_HEIGHT = 190;

export interface TaskTimelineAreaProps {
  board: TaskBoard | null;
  onPressTask: (task: KanbanTask) => void;
  height: number;
  onResize: (height: number) => void;
  containerStyle?: StyleProp<ViewStyle>;
  /** Compact hides the splitter: the timeline is its own tab there, full height. */
  resizable?: boolean;
}

/**
 * The board's "when" area: the schedule, plus a splitter the user drags to share
 * the vertical space with the kanban.
 *
 * Quotas used to sit on a permanent strip above it; they now live in the header
 * ring (see task-quota-menu.tsx), which gives the schedule the whole area.
 */
export function TaskTimelineArea({
  board,
  onPressTask,
  height,
  onResize,
  containerStyle,
  resizable = true,
}: TaskTimelineAreaProps) {
  const heightRef = useRef(height);
  heightRef.current = height;
  const getHeight = useCallback(() => heightRef.current, []);

  const areaStyle = useMemo(
    () => [styles.area, resizable ? { height } : styles.areaFill, containerStyle],
    [height, resizable, containerStyle],
  );

  return (
    <View>
      <View style={areaStyle}>
        {board ? (
          <View style={styles.ganttHost}>
            <TaskGantt board={board} onPressTask={onPressTask} fill />
          </View>
        ) : null}
      </View>
      {resizable ? <TimelineSplitter getHeight={getHeight} onResize={onResize} /> : null}
    </View>
  );
}

/**
 * Draggable divider between the timeline and the kanban. Dragging DOWN grows the
 * timeline, which is the direction the handle visually suggests.
 */
function TimelineSplitter({
  getHeight,
  onResize,
}: {
  getHeight: () => number;
  onResize: (height: number) => void;
}) {
  const startRef = useRef(0);
  const handleStyle = useMemo(() => [styles.splitter, rowResizeCursor], []);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .hitSlop({ top: 8, bottom: 8 })
        .onStart(() => {
          startRef.current = getHeight();
        })
        .onUpdate((event) => {
          const next = startRef.current + event.translationY;
          onResize(Math.min(MAX_TIMELINE_HEIGHT, Math.max(MIN_TIMELINE_HEIGHT, next)));
        }),
    [getHeight, onResize],
  );
  return (
    <GestureDetector gesture={gesture}>
      <View style={handleStyle} accessibilityRole="adjustable" testID="tasks-timeline-splitter">
        <View style={styles.splitterLine} />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create((theme) => ({
  area: {
    overflow: "hidden",
  },
  areaFill: {
    flex: 1,
  },
  ganttHost: {
    flex: 1,
    minHeight: 0,
  },
  // Generous touch target around a hairline, so the divider is easy to grab
  // without drawing attention to itself.
  splitter: {
    height: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  splitterLine: {
    width: 48,
    height: 3,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.border,
  },
}));

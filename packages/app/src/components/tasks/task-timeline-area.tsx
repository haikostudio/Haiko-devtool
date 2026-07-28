import { View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { KanbanTask, TaskBoard } from "@/data/tasks";
import { TaskGantt } from "./task-gantt";

export interface TaskTimelineAreaProps {
  board: TaskBoard | null;
  onPressTask: (task: KanbanTask) => void;
  containerStyle?: StyleProp<ViewStyle>;
  /** Compact shows the timeline as its own tab, where it takes the full area. */
  fill?: boolean;
}

/**
 * The board's "when" area: the schedule strip above the kanban.
 *
 * The strip used to be a fixed 190px slab with a drag handle under it, which
 * left a tall blank band whenever nothing was scheduled. It now sizes itself
 * from its rows (see task-gantt.tsx), so the kanban keeps every pixel the
 * schedule does not need and the manual splitter has nothing left to do.
 *
 * Quotas used to sit on a permanent strip above it; they now live in the header
 * ring (see task-quota-menu.tsx).
 */
export function TaskTimelineArea({
  board,
  onPressTask,
  containerStyle,
  fill = false,
}: TaskTimelineAreaProps) {
  if (!board) {
    return null;
  }
  return (
    <View style={fill ? styles.areaFill : undefined}>
      <TaskGantt
        board={board}
        onPressTask={onPressTask}
        containerStyle={containerStyle}
        fill={fill}
      />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  areaFill: {
    flex: 1,
  },
}));

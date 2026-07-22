import { useCallback, useMemo } from "react";
import { Modal, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { TaskAgentPanel } from "@/components/tasks/task-agent-panel";
import type { TaskDetailSaveInput } from "@/components/tasks/task-detail-sheet";
import type { KanbanTask } from "@/data/tasks";

interface CompactTaskAgentSheetProps {
  serverId: string | null;
  projectId: string | null;
  task: KanbanTask | null;
  visible: boolean;
  onClose: () => void;
  onSave: (input: TaskDetailSaveInput) => void;
  onDelete: (taskId: string) => void;
  onEstimate: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  onSetHold?: (taskId: string, hold: boolean) => void;
}

const noop = () => {};

// Drag further than this (or flick faster than the velocity floor) to dismiss.
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 900;

/**
 * Compact (mobile) full-screen presentation of a task's "Details" drawer — the
 * same "Details" + "Billing" tabs the desktop side panel offers. Opened from the
 * chat dock header's "Details" button (the task's live agent chat lives in the
 * shared bottom dock now, not here). Fresh mount per task (`key`) so no state
 * leaks between cards.
 *
 * A grab handle sits at the very top (below the safe-area inset) so the drawer
 * reads as draggable: dragging it down past a threshold slides the sheet away
 * and closes it. The gesture lives on the handle strip only — never on the body
 * — so it never fights the embedded agent scroll/terminal underneath.
 *
 * `react-native-gesture-handler` needs its own root inside a native `Modal` (the
 * app-level root doesn't cross the modal's separate view hierarchy), hence the
 * `GestureHandlerRootView` wrapper here.
 *
 * Only the top safe-area inset is applied: the handle+header sit at the top while
 * the embedded agent pane owns its own bottom/keyboard insets — padding the host
 * bottom too would double up (see the app's known double-safe-area pitfall).
 */
export function CompactTaskAgentSheet(props: CompactTaskAgentSheetProps) {
  const insets = useSafeAreaInsets();
  const { onClose } = props;
  const translateY = useSharedValue(0);

  const handleClose = useCallback(() => {
    translateY.value = 0;
    onClose();
  }, [onClose, translateY]);

  const dragGesture = useMemo(
    () =>
      Gesture.Pan()
        .onChange((event) => {
          // Downward only: an upward drag on a full-height sheet has nowhere to go.
          translateY.value = Math.max(0, translateY.value + event.changeY);
        })
        .onEnd((event) => {
          const shouldDismiss =
            translateY.value > DISMISS_DISTANCE || event.velocityY > DISMISS_VELOCITY;
          if (shouldDismiss) {
            translateY.value = withTiming(900, { duration: 180 }, () => {
              runOnJS(handleClose)();
            });
          } else {
            translateY.value = withSpring(0, { damping: 20, stiffness: 220 });
          }
        }),
    [handleClose, translateY],
  );

  const contentStyle = useAnimatedStyle(() => ({
    flex: 1,
    // Bounded height must reach the embedded agent stream so it can scroll on
    // web (flex children default to `min-height: auto` — see styles below).
    minHeight: 0,
    transform: [{ translateY: translateY.value }],
  }));

  const hostStyle = useMemo(
    () => [styles.host, { paddingTop: Math.max(insets.top, 8) }],
    [insets.top],
  );

  if (!props.task) {
    return null;
  }

  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      onRequestClose={handleClose}
      transparent={false}
    >
      <GestureHandlerRootView style={styles.root}>
        <View style={hostStyle}>
          <Animated.View style={contentStyle}>
            <GestureDetector gesture={dragGesture}>
              <View style={styles.handleArea}>
                <View style={styles.handle} />
              </View>
            </GestureDetector>
            <View style={styles.panelHost}>
              <TaskAgentPanel
                key={props.task.id}
                fullscreen
                serverId={props.serverId}
                projectId={props.projectId}
                task={props.task}
                collapsed={false}
                onToggleCollapse={noop}
                onClose={handleClose}
                onSave={props.onSave}
                onDelete={props.onDelete}
                onEstimate={props.onEstimate}
                onRunNow={props.onRunNow}
                onApprove={props.onApprove}
                onSetHold={props.onSetHold}
              />
            </View>
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
  },
  host: {
    flex: 1,
    // Every flex-column ancestor between the full-screen root and the chat
    // stream needs `minHeight: 0` on web, otherwise it expands to its content
    // and the discussion overflows without scrolling.
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  panelHost: {
    flex: 1,
    minHeight: 0,
  },
  handleArea: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[2],
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.palette.zinc[600],
  },
}));

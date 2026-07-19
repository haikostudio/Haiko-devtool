import { useMemo } from "react";
import { Modal, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TaskAgentPanel } from "@/components/tasks/task-agent-panel";
import type { TaskDetailSaveInput } from "@/components/tasks/task-detail-sheet";
import type { KanbanTask } from "@/data/tasks";

interface CompactTaskAgentSheetProps {
  serverId: string | null;
  task: KanbanTask | null;
  visible: boolean;
  onClose: () => void;
  onSave: (input: TaskDetailSaveInput) => void;
  onDelete: (taskId: string) => void;
  onEstimate: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
  onApprove: (taskId: string) => void;
}

const noop = () => {};

/**
 * Compact (mobile) full-screen presentation of a task's agent + editor. On phones
 * a task tap opens this instead of the config-only detail sheet, so mobile gets
 * the same "Chat" + "Details" tabs the desktop side panel offers — the live agent
 * mirror and the task editor in one drawer. Fresh mount per task (`key`) so no
 * state leaks between cards.
 *
 * Only the top safe-area inset is applied here: the header sits at the top, while
 * the embedded agent pane owns its own bottom/keyboard insets — padding the host
 * bottom too would double up (see the app's known double-safe-area pitfall).
 */
export function CompactTaskAgentSheet(props: CompactTaskAgentSheetProps) {
  const insets = useSafeAreaInsets();
  const hostStyle = useMemo(() => [styles.host, { paddingTop: insets.top }], [insets.top]);
  if (!props.task) {
    return null;
  }
  return (
    <Modal
      visible={props.visible}
      animationType="slide"
      onRequestClose={props.onClose}
      transparent={false}
    >
      <View style={hostStyle}>
        <TaskAgentPanel
          key={props.task.id}
          fullscreen
          serverId={props.serverId}
          task={props.task}
          collapsed={false}
          onToggleCollapse={noop}
          onClose={props.onClose}
          onSave={props.onSave}
          onDelete={props.onDelete}
          onEstimate={props.onEstimate}
          onRunNow={props.onRunNow}
          onApprove={props.onApprove}
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  host: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
}));

import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bot } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import type { KanbanTask } from "@/data/tasks";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
} from "@/screens/workspace/workspace-pane-content";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedBot = withUnistyles(Bot);

export interface TaskAgentChatProps {
  serverId: string | null;
  task: KanbanTask;
  onRunNow: (taskId: string) => void;
}

/**
 * Live mirror of a task's primary agent, shown in the shared bottom chat dock.
 * Resolves the task's linked agent + workspace and embeds the same
 * `WorkspacePaneContent` the workspace screen mounts, so it's a live view — not a
 * copy. When the task has no agent yet, offers to launch one. Extracted from the
 * former in-drawer chat tab so the dock and any future host can reuse it; mount
 * it with a `key` per agentId so switching tasks fully remounts the pane.
 */
export function TaskAgentChat({ serverId, task, onRunNow }: TaskAgentChatProps) {
  const { t } = useTranslation();
  // Prefer the pipeline agent: analysis AND execution live in that one
  // conversation, so it holds the live thread the card's "Analyse en cours"
  // badge refers to. primaryAgentId may point at a proposing/interactive agent
  // with an empty conversation — binding to it showed a blank chat while the
  // task was actively working. Fall back to primaryAgentId for legacy tasks
  // that predate taskAgentId.
  const agentId = task.links.taskAgentId ?? task.links.primaryAgentId ?? null;
  // Prefer the task's recorded workspace; fall back to the agent's own workspace
  // from the session store so the embedded pane always has a scope.
  const agentWorkspaceId = useSessionStore((state) =>
    serverId && agentId ? state.sessions[serverId]?.agents?.get(agentId)?.workspaceId : undefined,
  );
  const workspaceId = task.links.workspaceId ?? agentWorkspaceId ?? null;

  const handleRun = useCallback(() => onRunNow(task.id), [onRunNow, task.id]);

  if (serverId && agentId && workspaceId) {
    return <EmbeddedAgentPane serverId={serverId} agentId={agentId} workspaceId={workspaceId} />;
  }

  return (
    <View style={styles.emptyState}>
      <ThemedBot size={ICON_SIZE.lg} uniProps={mutedColorMapping} />
      <Text style={styles.emptyText}>{t("tasks.panel.noAgent")}</Text>
      {serverId ? (
        <Button onPress={handleRun} testID="task-panel-launch-agent">
          {t("tasks.panel.launchAgent")}
        </Button>
      ) : null}
    </View>
  );
}

function EmbeddedAgentPane({
  serverId,
  agentId,
  workspaceId,
}: {
  serverId: string;
  agentId: string;
  workspaceId: string;
}) {
  const content = useMemo(() => {
    const openInNativeWorkspace = () => {
      navigateToAgent({ serverId, agentId, workspaceId });
    };
    return buildWorkspacePaneContentModel({
      tab: {
        key: `tasks:agent:${agentId}`,
        tabId: `tasks:agent:${agentId}`,
        kind: "agent",
        target: { kind: "agent", agentId },
      },
      normalizedServerId: serverId,
      normalizedWorkspaceId: workspaceId,
      // The tasks board owns no tab strip; tab-management intents fall back to
      // opening the agent in its native workspace.
      onOpenTab: openInNativeWorkspace,
      onCloseCurrentTab: openInNativeWorkspace,
      onRetargetCurrentTab: openInNativeWorkspace,
      onOpenWorkspaceFile: openInNativeWorkspace,
      onOpenImportSheet: openInNativeWorkspace,
    });
  }, [serverId, agentId, workspaceId]);

  return (
    <View style={styles.paneHost}>
      <WorkspacePaneContent content={content} isWorkspaceFocused isPaneFocused />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  paneHost: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

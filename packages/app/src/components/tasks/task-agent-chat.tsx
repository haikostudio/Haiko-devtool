import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bot, CheckCircle2 } from "lucide-react-native";
import { AboveComposerSlotProvider } from "@/panels/above-composer-slot";
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
const accentColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedCheck = withUnistyles(CheckCircle2);

export interface TaskAgentChatProps {
  serverId: string | null;
  task: KanbanTask;
  onRunNow: (taskId: string) => void;
  /**
   * Mark the task validated. Shown as a full-width bar right above the prompt
   * composer as soon as the agent has spoken once — the user, not the agent,
   * decides a task is finished.
   */
  onValidate?: (taskId: string) => void;
}

/**
 * Live mirror of a task's primary agent, shown in the shared bottom chat dock.
 * Resolves the task's linked agent + workspace and embeds the same
 * `WorkspacePaneContent` the workspace screen mounts, so it's a live view — not a
 * copy. When the task has no agent yet, offers to launch one. Extracted from the
 * former in-drawer chat tab so the dock and any future host can reuse it; mount
 * it with a `key` per agentId so switching tasks fully remounts the pane.
 */
export function TaskAgentChat({ serverId, task, onRunNow, onValidate }: TaskAgentChatProps) {
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
  // "The agent has produced at least one reply": the synthesis is regenerated on
  // every interaction, so its presence is the cheapest honest signal. A task that
  // already carries a sub-status has clearly been worked on too.
  const agentHasSpoken = useSessionStore((state) =>
    serverId && agentId
      ? Boolean(state.sessions[serverId]?.agents?.get(agentId)?.synthesis)
      : false,
  );
  const isFinished = task.column === "done" || task.column === "deployed";
  const showValidate =
    Boolean(onValidate) && !isFinished && (agentHasSpoken || task.progress != null);

  const handleRun = useCallback(() => onRunNow(task.id), [onRunNow, task.id]);
  const handleValidate = useCallback(() => onValidate?.(task.id), [onValidate, task.id]);

  // Memoized so the embedded pane (and everything under it) is not re-rendered
  // by a fresh element on every keystroke in the composer.
  const validateBar = useMemo(
    () =>
      showValidate ? (
        <ValidateTaskBar onPress={handleValidate} ready={task.progress === "ready_for_review"} />
      ) : null,
    [showValidate, handleValidate, task.progress],
  );

  if (serverId && agentId && workspaceId) {
    return (
      <EmbeddedAgentPane
        serverId={serverId}
        agentId={agentId}
        workspaceId={workspaceId}
        validateBar={validateBar}
      />
    );
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

/**
 * Full-width, deliberately quiet bar. It carries the single "Valider la tâche"
 * action and nothing else, so it never competes with the conversation or the
 * prompt field it sits on. Visible for the whole discussion, not only when the
 * agent thinks it is done.
 */
function ValidateTaskBar({ onPress, ready }: { onPress: () => void; ready: boolean }) {
  const { t } = useTranslation();
  return (
    <Pressable
      onPress={onPress}
      style={validateBarStyle}
      accessibilityRole="button"
      accessibilityLabel={t("tasks.panel.validateTask")}
      testID="task-validate-bar"
    >
      <ThemedCheck size={ICON_SIZE.sm} uniProps={ready ? accentColorMapping : mutedColorMapping} />
      <Text style={ready ? styles.validateTextReady : styles.validateText}>
        {t("tasks.panel.validateTask")}
      </Text>
    </Pressable>
  );
}

function validateBarStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.validateBar, (hovered || pressed) && styles.validateBarHovered];
}

function EmbeddedAgentPane({
  serverId,
  agentId,
  workspaceId,
  validateBar,
}: {
  serverId: string;
  agentId: string;
  workspaceId: string;
  validateBar: React.ReactNode;
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
    <AboveComposerSlotProvider node={validateBar}>
      <View style={styles.paneHost}>
        <WorkspacePaneContent content={content} isWorkspaceFocused isPaneFocused />
      </View>
    </AboveComposerSlotProvider>
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
  validateBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    width: "100%",
    paddingVertical: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  validateBarHovered: {
    backgroundColor: theme.colors.surface2,
  },
  validateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  validateTextReady: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
}));

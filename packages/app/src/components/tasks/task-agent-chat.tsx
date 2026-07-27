import { useCallback, useMemo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bot, CheckCircle2, Play } from "lucide-react-native";
import { AboveComposerSlotProvider } from "@/panels/above-composer-slot";
import { HostOwnsComposerSafeAreaProvider } from "@/panels/embedded-composer-context";
import { Button } from "@/components/ui/button";
import type { KanbanTask } from "@/data/tasks";
import { useSessionStore } from "@/stores/session-store";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
} from "@/screens/workspace/workspace-pane-content";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedBot = withUnistyles(Bot);
// The validate bar is a filled green control, so its icon and spinner ride on
// the success foreground, not on the neutral text colors.
const successForegroundMapping = (theme: Theme) => ({ color: theme.colors.successForeground });
// The run-now bar is a filled accent control (distinct from the green validate
// bar), so its icon rides on the accent foreground.
const accentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const ThemedCheck = withUnistyles(CheckCircle2);
const ThemedPlay = withUnistyles(Play);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);

export interface TaskAgentChatProps {
  serverId: string | null;
  task: KanbanTask;
  /**
   * Force the "Planifié" → "En cours" transition immediately. Drives both the
   * empty-state "launch agent" action and the run-now bar shown above the prompt
   * composer while the card is scheduled — the launch control lives here, next to
   * the validate control, instead of on the kanban card.
   */
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
  // The bar only exists for a card that is actually being worked on: "En cours"
  // is the one column a task can legitimately leave for "Terminée". Offering the
  // final check on a note, a backlog item, a validated-but-not-started card or a
  // scheduled one invited finishing work that never ran — and the analysis agent
  // talking during estimation was enough to make the bar appear. Finished cards
  // (done/deployed) are excluded by the same rule.
  const isInProgress = task.column === "in_progress";
  const showValidate =
    Boolean(onValidate) && isInProgress && (agentHasSpoken || task.progress != null);
  // The run-now bar sits on a scheduled card only: it forces the launch the user
  // already asked for by validating the card, and lives right above the prompt so
  // the launch and validate controls share one home instead of one being on the
  // kanban card and the other above the composer.
  const showRunNow = task.column === "scheduled";

  const handleRun = useCallback(() => onRunNow(task.id), [onRunNow, task.id]);
  const handleValidate = useCallback(() => onValidate?.(task.id), [onValidate, task.id]);

  // Memoized so the embedded pane (and everything under it) is not re-rendered
  // by a fresh element on every keystroke in the composer. Scheduled and
  // in-progress are mutually exclusive columns, so at most one bar shows.
  const aboveComposerBar = useMemo(() => {
    if (showRunNow) {
      return <RunNowTaskBar onPress={handleRun} />;
    }
    if (showValidate) {
      return (
        <ValidateTaskBar
          onPress={handleValidate}
          ready={task.progress === "ready_for_review"}
          validation={task.validation}
        />
      );
    }
    return null;
  }, [showRunNow, showValidate, handleRun, handleValidate, task.progress, task.validation]);

  if (serverId && agentId && workspaceId) {
    return (
      <EmbeddedAgentPane
        serverId={serverId}
        agentId={agentId}
        workspaceId={workspaceId}
        validateBar={aboveComposerBar}
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
 * Full-width, deliberately quiet bar. It carries the single "Lancer le contrôle"
 * action and nothing else, so it never competes with the conversation or the
 * prompt field it sits on. Visible for the whole discussion, not only when the
 * agent thinks it is done.
 *
 * It shows no report of its own: the check runs in the conversation right above,
 * so the verification, the fixes and the verdict are all readable there. It also
 * stays pressable while a check runs — a second press asks for confirmation
 * rather than being silently ignored, so a check can never leave the bar stuck.
 */
function ValidateTaskBar({
  onPress,
  ready,
  validation,
}: {
  onPress: () => void;
  ready: boolean;
  validation: KanbanTask["validation"];
}) {
  const { t } = useTranslation();
  const running = validation?.state === "running";
  return (
    // Outer/inner pair mirrors the composer's own geometry (same horizontal
    // padding, same MAX_CONTENT_WIDTH cap, centered) so the bar lines up exactly
    // with the prompt field it sits on instead of overhanging it.
    <View style={styles.validateOuter}>
      <View style={styles.validateInner}>
        <Pressable
          onPress={onPress}
          style={validateBarStyle}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.panel.validateTask")}
          testID="task-validate-bar"
        >
          {running ? (
            <ThemedActivityIndicator size="small" uniProps={successForegroundMapping} />
          ) : (
            <ThemedCheck size={ICON_SIZE.sm} uniProps={successForegroundMapping} />
          )}
          <Text style={ready && !running ? styles.validateTextReady : styles.validateText}>
            {running ? t("tasks.panel.validateRunning") : t("tasks.panel.validateTask")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function validateBarStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.validateBar, (hovered || pressed) && styles.validateBarHovered];
}

/**
 * Full-width accent bar carrying the single "Lancer maintenant" action, shown on
 * a scheduled card right above the prompt composer. It mirrors ValidateTaskBar's
 * geometry (same outer/inner alignment to the composer) so the two control bars
 * feel like one family, but wears the accent color to stay distinct from the
 * green "finish" control. Pressing it forces the "Planifié" → "En cours"
 * transition immediately, bypassing the off-peak window and the 5h-quota gate.
 */
function RunNowTaskBar({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.validateOuter}>
      <View style={styles.validateInner}>
        <Pressable
          onPress={onPress}
          style={runNowBarStyle}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.actions.runNow")}
          testID="task-run-now-bar"
        >
          <ThemedPlay size={ICON_SIZE.sm} uniProps={accentForegroundMapping} />
          <Text style={styles.runNowText}>{t("tasks.actions.runNow")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function runNowBarStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.runNowBar, (hovered || pressed) && styles.runNowBarHovered];
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
      {/* The dock sheet already pads its body by the safe area, so tell the
          embedded composer not to add its own — otherwise the two stack into an
          empty white band under the input. */}
      <HostOwnsComposerSafeAreaProvider>
        <View style={styles.paneHost}>
          <WorkspacePaneContent content={content} isWorkspaceFocused isPaneFocused />
        </View>
      </HostOwnsComposerSafeAreaProvider>
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
  // Same padding the composer applies to its own input area, so the bar's edges
  // land on the prompt field's edges at every breakpoint.
  validateOuter: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[4],
    },
  },
  validateInner: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
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
    borderColor: theme.colors.statusSuccess,
    backgroundColor: theme.colors.statusSuccess,
  },
  validateBarHovered: {
    opacity: 0.88,
  },
  validateText: {
    color: theme.colors.successForeground,
    fontSize: theme.fontSize.sm,
  },
  validateTextReady: {
    color: theme.colors.successForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  // Same geometry as validateBar, filled with the accent color so the launch
  // control stays visually distinct from the green finish control.
  runNowBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    width: "100%",
    paddingVertical: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
  },
  runNowBarHovered: {
    opacity: 0.88,
  },
  runNowText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
}));

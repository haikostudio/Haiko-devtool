import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Archive,
  BadgeCheck,
  Bot,
  CheckCircle2,
  Play,
  Power,
  Undo2,
  Rocket,
  RotateCw,
} from "lucide-react-native";
import { AboveComposerSlotProvider } from "@/panels/above-composer-slot";
import { HostOwnsComposerSafeAreaProvider } from "@/panels/embedded-composer-context";
import { Button } from "@/components/ui/button";
import type { KanbanTask } from "@/data/tasks";
import { resolveRunNowState } from "@/components/tasks/task-run-now-state";
import { isTaskDeployed, offersDaemonRestart } from "@/components/tasks/task-card-badge";
import {
  isRestartCancellable,
  type RestartProgress,
} from "@/components/tasks/daemon-restart-progress";
import { restartProgressLabel } from "@/components/tasks/restart-progress-label";
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
// The approve bar is a filled primary control (distinct from both the green
// final-check bar and the accent run-now bar), so its icon rides on the primary
// foreground.
const primaryForegroundMapping = (theme: Theme) => ({ color: theme.colors.primaryForeground });
const ThemedCheck = withUnistyles(CheckCircle2);
const ThemedBadgeCheck = withUnistyles(BadgeCheck);
const ThemedPlay = withUnistyles(Play);
const ThemedRotate = withUnistyles(RotateCw);
const ThemedArchive = withUnistyles(Archive);
// The restart bar is an outlined warning control, matching the card's amber
// "Redémarrage requis" pill so the promise and the control read as one thing.
const warningForegroundMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const ThemedPower = withUnistyles(Power);
const ThemedUndo = withUnistyles(Undo2);
const ThemedRocket = withUnistyles(Rocket);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);

/** No restart in flight — the bar simply offers the gesture. */
const IDLE_RESTART: RestartProgress = { state: "idle" };

/**
 * Which of the two finished-card bars a card offers, resolved together so their
 * branches stay off the render function's complexity budget. The publication flow
 * is finish → queue → publish: a "Terminé" (`done`) card is queued into the
 * "À déployer" column (the button twin of the drag), and a card already waiting
 * there (`deployed`) is published on its own by the per-card deploy bar. Once the
 * work is live neither bar shows — the card wears a "Déployé" badge instead.
 * Entering the column never marks a card live, and neither does either bar; the
 * single stamp of "this is online" stays the column's "Tout déployer" batch.
 */
function resolveFinishedCardBars(
  task: KanbanTask,
  handlers: {
    onQueueDeploy?: ((taskId: string) => void) | undefined;
    onDeploy?: ((taskId: string) => void) | undefined;
  },
): { showQueueDeploy: boolean; showDeploy: boolean } {
  if (isTaskDeployed(task)) {
    return { showQueueDeploy: false, showDeploy: false };
  }
  return {
    showQueueDeploy: Boolean(handlers.onQueueDeploy) && task.column === "done",
    showDeploy: Boolean(handlers.onDeploy) && task.column === "deployed",
  };
}

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
  onValidate?: (taskId: string, options?: { queueOnComplete?: boolean }) => void;
  /**
   * Validate a "À faire" (backlog) card: move it into "Validé" and arm the
   * analysis. Shown as a full-width bar above the prompt composer while the card
   * sits in backlog. This is the pipeline's single consent gesture — the user,
   * never the agent, admits a card into the pipeline (see
   * docs/task-board-cycle.md). Distinct from `onValidate`, which is the
   * "En cours" → "Terminé" final check.
   */
  onApproveTask?: (taskId: string) => void;
  /**
   * Archive (hide) a finished card. Shown as a full-width bar above the prompt
   * composer while the card sits in "Terminé"/"Déployé". Archiving only hides the
   * card from the board — it never moves or publishes it (see
   * docs/task-board-cycle.md).
   */
  onArchive?: (taskId: string) => void;
  /**
   * Deploy a finished ("Terminé") card: hand its agent a deploy-then-confirm
   * prompt that verifies, deploys and moves the card to "Déployé" itself. Shown
   * as a full-width bar above the prompt composer while the card sits in
   * "Terminé" — takes the slot ahead of the archive bar there, so the natural
   * order is deploy, then archive.
   */
  onDeploy?: (taskId: string) => void;
  /**
   * Queue a finished ("Terminé") card into the "À déployer" column — the button
   * twin of dragging the card there. It only ENQUEUES (moves the column); it
   * never marks the card live. Publication happens later, in one run, via the
   * column's "Tout déployer". Shown on a "Terminé" card, ahead of the per-card
   * deploy bar, so the natural flow is: finish → queue → publish the batch.
   */
  onQueueDeploy?: (taskId: string) => void;
  /**
   * Restart the Paseo daemon. Offered on a card whose work is live but only
   * takes effect after a restart, so the publication can be finished without a
   * terminal. The host confirms first (a restart drops every running agent) —
   * this fires only once the user has said yes.
   */
  onRestartDaemon?: (taskId: string) => void;
  /** Takes back a restart while its undo window is still open. */
  onCancelRestartDaemon?: () => void;
  /** Live restart state, so the bar can count down to the reconnection. */
  restartProgress?: RestartProgress;
}

/**
 * Live mirror of a task's primary agent, shown in the shared bottom chat dock.
 * Resolves the task's linked agent + workspace and embeds the same
 * `WorkspacePaneContent` the workspace screen mounts, so it's a live view — not a
 * copy. When the task has no agent yet, offers to launch one. Extracted from the
 * former in-drawer chat tab so the dock and any future host can reuse it; mount
 * it with a `key` per agentId so switching tasks fully remounts the pane.
 */
export function TaskAgentChat({
  serverId,
  task,
  onRunNow,
  onValidate,
  onApproveTask,
  onArchive,
  onDeploy,
  onQueueDeploy,
  onRestartDaemon,
  onCancelRestartDaemon,
  restartProgress = IDLE_RESTART,
}: TaskAgentChatProps) {
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
  // Live lifecycle status of the card's own agent, kept as a narrow selector so a
  // status change re-renders this bar host without dragging the whole session
  // object through. "running" = the agent is mid-turn (working); any other value
  // ("idle" once it stops, "initializing"/"error"/"closed") means it is not
  // actively working. The action bars read this to disable a gesture that cannot
  // legitimately fire yet — chiefly finishing a card while its agent still works.
  const agentStatus = useSessionStore((state) =>
    serverId && agentId ? state.sessions[serverId]?.agents?.get(agentId)?.status : undefined,
  );
  const agentBusy = agentStatus === "running";
  // "The agent has produced at least one reply": the synthesis is regenerated on
  // every interaction, so its presence is the cheapest honest signal. A task that
  // already carries a sub-status has clearly been worked on too.
  const agentHasSpoken = useSessionStore((state) =>
    serverId && agentId
      ? Boolean(state.sessions[serverId]?.agents?.get(agentId)?.synthesis)
      : false,
  );
  // "The agent finished with a result": its turn has ended (status is "idle",
  // not mid-turn) AND it has spoken at least once. There is no distinct
  // "completed" lifecycle state — an agent that is done simply goes back to
  // "idle" — so idle+spoken is the honest definition of "ready for the final
  // check". This is the signal that makes finishing the card legitimate, not the
  // mere fact the card sits in "En cours".
  const agentReady = agentStatus === "idle" && agentHasSpoken;
  // The bar only exists for a card that is actually being worked on: "En cours"
  // is the one column a task can legitimately leave for "Terminée". It appears in
  // exactly two agent states — working (`agentBusy`, shown disabled with an "En
  // exécution…" label) and finished-with-a-result (`agentReady`, shown enabled).
  // It used to also appear the instant `task.progress` became non-null, which is
  // set the moment the card enters the column, so the green enabled button showed
  // before the agent had produced anything and the user could finish an empty
  // task. Gating on the real agent state closes that hole. Finished cards
  // (done/deployed) are excluded by the column rule.
  const isInProgress = task.column === "in_progress";
  const showValidate = Boolean(onValidate) && isInProgress && (agentReady || agentBusy);
  // The run-now bar sits on a scheduled card only: it forces the launch the user
  // already asked for by validating the card, and lives right above the prompt so
  // the launch and validate controls share one home instead of one being on the
  // kanban card and the other above the composer.
  const showRunNow = task.column === "scheduled";
  // The approve bar sits on a backlog ("À faire") card only: it is the user's
  // single consent gesture that admits the card into the pipeline. Until now the
  // only path out of backlog was a manual drag on the board; this puts the same
  // decision right above the prompt, next to the run/finish controls.
  const showApprove = Boolean(onApproveTask) && task.column === "backlog";
  // The archive bar sits on a finished card ("Terminé"/"Déployé"): it files the
  // card away by hiding it from the board. It never publishes or moves the card —
  // publication already happened on its own when the card reached "Terminé".
  const showArchive = Boolean(onArchive) && (task.column === "done" || task.column === "deployed");
  // The queue and per-card-deploy bars for a finished card, resolved together in
  // a module helper so their branches stay off this render function's complexity
  // budget. A "Terminé" card is queued into "À déployer" (button twin of the
  // drag); a card already waiting there is published on its own by the per-card
  // deploy bar. Neither entering the column nor either bar ever stamps the card
  // live — that stays the batch's job.
  const { showQueueDeploy, showDeploy } = resolveFinishedCardBars(task, {
    onQueueDeploy,
    onDeploy,
  });
  // The restart bar is the other side of the publication: the work IS live, and
  // a daemon restart is the only thing left between the user and their feature.
  // It takes the slot ahead of the archive bar, so the natural order stays
  // deploy → restart → archive, with no terminal in the middle.
  const showRestartDaemon = Boolean(onRestartDaemon) && offersDaemonRestart(task);

  const handleRun = useCallback(() => onRunNow(task.id), [onRunNow, task.id]);
  const handleValidate = useCallback(() => onValidate?.(task.id), [onValidate, task.id]);
  // "Terminer et mettre en file": the same check, plus the consent for the card
  // to continue into "À déployer" the moment it completes.
  const handleValidateAndQueue = useCallback(
    () => onValidate?.(task.id, { queueOnComplete: true }),
    [onValidate, task.id],
  );
  const handleApprove = useCallback(() => onApproveTask?.(task.id), [onApproveTask, task.id]);
  const handleArchive = useCallback(() => onArchive?.(task.id), [onArchive, task.id]);
  const handleDeploy = useCallback(() => onDeploy?.(task.id), [onDeploy, task.id]);
  const handleQueueDeploy = useCallback(() => onQueueDeploy?.(task.id), [onQueueDeploy, task.id]);
  const handleRestartDaemon = useCallback(
    () => onRestartDaemon?.(task.id),
    [onRestartDaemon, task.id],
  );
  const handleCancelRestartDaemon = useCallback(
    () => onCancelRestartDaemon?.(),
    [onCancelRestartDaemon],
  );

  // Memoized so the embedded pane (and everything under it) is not re-rendered
  // by a fresh element on every keystroke in the composer. Backlog, scheduled and
  // in-progress are mutually exclusive columns, so at most one bar shows.
  const aboveComposerBar = useMemo(() => {
    if (showApprove) {
      return <ApproveTaskBar onPress={handleApprove} />;
    }
    if (showRunNow) {
      return <RunNowTaskBar onPress={handleRun} schedule={task.schedule} />;
    }
    if (showValidate) {
      return (
        <ValidateTaskBar
          onPress={handleValidate}
          onPressAndQueue={handleValidateAndQueue}
          ready={task.progress === "ready_for_review"}
          validation={task.validation}
          agentReady={agentReady}
        />
      );
    }
    if (showQueueDeploy) {
      return <QueueDeployBar onPress={handleQueueDeploy} />;
    }
    if (showDeploy) {
      return <DeployTaskBar onPress={handleDeploy} deployment={task.deployment} />;
    }
    if (showRestartDaemon) {
      return (
        <RestartDaemonBar
          onPress={handleRestartDaemon}
          onCancel={handleCancelRestartDaemon}
          progress={restartProgress}
        />
      );
    }
    if (showArchive) {
      return <ArchiveTaskBar onPress={handleArchive} />;
    }
    return null;
  }, [
    showApprove,
    showRunNow,
    showValidate,
    showQueueDeploy,
    showDeploy,
    showRestartDaemon,
    showArchive,
    handleApprove,
    handleRun,
    handleValidate,
    handleValidateAndQueue,
    handleQueueDeploy,
    handleDeploy,
    handleRestartDaemon,
    handleCancelRestartDaemon,
    handleArchive,
    restartProgress,
    task.progress,
    task.validation,
    task.deployment,
    task.schedule,
    agentReady,
  ]);

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
      {serverId ? <LaunchAgentButton onPress={handleRun} schedule={task.schedule} /> : null}
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
 * so the verification, the fixes and the verdict are all readable there.
 *
 * It is enabled only when the card's agent has actually finished with a result
 * (`agentReady` — idle and having spoken). It is disabled in the two states where
 * finishing a card is not a legitimate gesture: while a final check is already
 * running (`validation.state === "running"`) — so a second press can never fire a
 * duplicate check — and while the agent has not finished (still mid-turn, or not
 * yet ready), where the bar stays visible with an "En exécution…" label so the
 * user understands why it is inert. It enables on its own the instant the agent
 * goes idle with a result (the store's live status drives it, no reload). A
 * running check always implies an unfinished agent, so its label wins.
 */
function ValidateTaskBar({
  onPress,
  onPressAndQueue,
  ready,
  validation,
  agentReady,
}: {
  onPress: () => void;
  /** Same check, and the card continues into "À déployer" once it completes. */
  onPressAndQueue: () => void;
  ready: boolean;
  validation: KanbanTask["validation"];
  agentReady: boolean;
}) {
  const { t } = useTranslation();
  const running = validation?.state === "running";
  const disabled = running || !agentReady;
  let label = t("tasks.panel.validateTask");
  if (running) {
    label = t("tasks.panel.validateRunning");
  } else if (!agentReady) {
    label = t("tasks.panel.validateAgentBusy");
  }
  const barStyle = useCallback(
    (state: { pressed: boolean; hovered?: boolean }) => validateBarStyle({ ...state, disabled }),
    [disabled],
  );
  const a11yState = useMemo(() => ({ disabled }), [disabled]);
  return (
    // Outer/inner pair mirrors the composer's own geometry (same horizontal
    // padding, same MAX_CONTENT_WIDTH cap, centered) so the bar lines up exactly
    // with the prompt field it sits on instead of overhanging it.
    <View style={styles.validateOuter}>
      <View style={styles.validateInner}>
        <Pressable
          onPress={onPress}
          disabled={disabled}
          style={barStyle}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={a11yState}
          testID="task-validate-bar"
        >
          {running ? (
            <ThemedActivityIndicator size="small" uniProps={successForegroundMapping} />
          ) : (
            <ThemedCheck size={ICON_SIZE.sm} uniProps={successForegroundMapping} />
          )}
          <Text style={ready && !disabled ? styles.validateTextReady : styles.validateText}>
            {label}
          </Text>
        </Pressable>
        {/* The chaining variant, deliberately quieter than the bar above it: the
            default remains "the card stops in Terminé and you decide". Offered
            only while the check is actually startable — a second, inert control
            under an inert bar says nothing. */}
        {disabled ? null : (
          <Pressable
            onPress={onPressAndQueue}
            style={validateSecondaryStyle}
            accessibilityRole="button"
            accessibilityLabel={t("tasks.panel.validateAndQueue")}
            testID="task-validate-and-queue"
          >
            <Text style={styles.validateSecondaryText}>{t("tasks.panel.validateAndQueue")}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function validateSecondaryStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.validateSecondary, (hovered || pressed) && styles.validateSecondaryHovered];
}

function validateBarStyle({
  pressed,
  hovered,
  disabled,
}: {
  pressed: boolean;
  hovered?: boolean;
  disabled?: boolean;
}) {
  return [
    styles.validateBar,
    disabled && styles.barDisabled,
    !disabled && (hovered || pressed) && styles.validateBarHovered,
  ];
}

/**
 * The empty-state launch action, for a card whose agent does not exist yet. It
 * shares the run-now bar's honesty: a spinner while the launch is in flight, and
 * a retry wording once the attempts are spent — the button used to fire and then
 * look untouched whether or not anything actually started.
 */
function LaunchAgentButton({
  onPress,
  schedule,
}: {
  onPress: () => void;
  schedule: KanbanTask["schedule"];
}) {
  const { t } = useTranslation();
  const { pending, press } = useRunNowPending(onPress, schedule);
  const { labelKey, disabled } = resolveRunNowState(schedule, pending);
  // The default wording stays "Lancer l'agent" here: this button is the empty
  // state's own call to action, not the scheduled card's bar. Every other state
  // explains an absence of progress, so it wins over the generic label.
  const label = labelKey === "tasks.actions.runNow" ? "tasks.panel.launchAgent" : labelKey;
  // `loading` on Button implies disabled, so it rides on `disabled` (the local,
  // self-clearing press) and never on a daemon state — a card whose launch died
  // mid-flight must stay pressable. The label still says a launch is under way.
  return (
    <Button onPress={press} loading={disabled} testID="task-panel-launch-agent">
      {t(label)}
    </Button>
  );
}

/**
 * How long an optimistic "launching" spinner may survive without the server
 * confirming it. The daemon stamps `schedule.state = "launching"` at the very
 * top of a launch, so confirmation normally lands in well under a second; this
 * ceiling only exists so a rejected RPC (or a dropped socket) can never leave
 * the bar spinning forever. A stuck launch indicator is exactly the bug this
 * bar is meant to make impossible, so it must always be able to clear itself.
 */
const RUN_NOW_PENDING_TIMEOUT_MS = 10_000;

/**
 * Optimistic "I just pressed launch" flag, shared by the run-now bar and the
 * empty-state button so the two report a launch identically.
 *
 * It exists to close the gap before the daemon's own state lands, and it is
 * deliberately self-clearing — on the daemon's answer, or failing that on
 * RUN_NOW_PENDING_TIMEOUT_MS. It is the ONLY thing allowed to refuse a press, so
 * no launch indicator can ever latch this control off (see RunNowState.disabled).
 */
function useRunNowPending(
  onPress: () => void,
  schedule: KanbanTask["schedule"],
): { pending: boolean; press: () => void } {
  const [pending, setPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverState = schedule?.state;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // The daemon has answered — it either took the launch ("launching"/"running")
  // or recorded that it failed. Either way its own state now drives the control,
  // so drop the optimistic one rather than letting the two compete.
  useEffect(() => {
    if (
      pending &&
      (serverState === "launching" || serverState === "running" || serverState === "failed")
    ) {
      clearTimer();
      setPending(false);
    }
  }, [pending, serverState, clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  const press = useCallback(() => {
    setPending(true);
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      setPending(false);
    }, RUN_NOW_PENDING_TIMEOUT_MS);
    onPress();
  }, [onPress, clearTimer]);

  return { pending, press };
}

/** Spinner while a launch is in flight, retry glyph after a failure, play otherwise. */
function RunNowIcon({ busy, retry }: { busy: boolean; retry: boolean }) {
  if (busy) {
    return <ThemedActivityIndicator size="small" uniProps={accentForegroundMapping} />;
  }
  if (retry) {
    return <ThemedRotate size={ICON_SIZE.sm} uniProps={accentForegroundMapping} />;
  }
  return <ThemedPlay size={ICON_SIZE.sm} uniProps={accentForegroundMapping} />;
}

/**
 * Full-width accent bar carrying the single "Lancer maintenant" action, shown on
 * a scheduled card right above the prompt composer. It mirrors ValidateTaskBar's
 * geometry (same outer/inner alignment to the composer) so the two control bars
 * feel like one family, but wears the accent color to stay distinct from the
 * green "finish" control. Pressing it forces the "Planifié" → "En cours"
 * transition immediately, bypassing the off-peak window and the 5h-quota gate.
 *
 * The bar reports the launch instead of merely requesting it. A press used to
 * produce nothing but a transient toast, so a launch that never happened looked
 * identical to one still starting — the button just sat there. Now it spins while
 * the launch is in flight, names the reason a queued card has not started (quota,
 * quiet hours, analysis pending), and turns into an explicit "Échec du lancement
 * — réessayer" once the attempts are spent, which is also the gesture that
 * re-arms the card server-side.
 *
 * Crucially it never latches: a stalled launch still shows as busy but stays
 * pressable, so the cure is never behind the disease.
 */
function RunNowTaskBar({
  onPress,
  schedule,
}: {
  onPress: () => void;
  schedule: KanbanTask["schedule"];
}) {
  const { t } = useTranslation();
  const { pending, press: handlePress } = useRunNowPending(onPress, schedule);
  const { labelKey, busy, disabled, retry } = resolveRunNowState(schedule, pending);
  const label = t(labelKey);
  const barStyle = useCallback(
    (state: { pressed: boolean; hovered?: boolean }) => runNowBarStyle({ ...state, disabled }),
    [disabled],
  );
  const a11yState = useMemo(() => ({ disabled, busy }), [disabled, busy]);

  return (
    <View style={styles.validateOuter}>
      <View style={styles.validateInner}>
        <Pressable
          onPress={handlePress}
          disabled={disabled}
          style={barStyle}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={a11yState}
          testID="task-run-now-bar"
        >
          <RunNowIcon busy={busy} retry={retry} />
          <Text style={styles.runNowText}>{label}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function runNowBarStyle({
  pressed,
  hovered,
  disabled,
}: {
  pressed: boolean;
  hovered?: boolean;
  disabled?: boolean;
}) {
  return [
    styles.runNowBar,
    disabled && styles.barDisabled,
    !disabled && (hovered || pressed) && styles.runNowBarHovered,
  ];
}

/**
 * Full-width primary bar carrying the single "Valider la tâche" action, shown on
 * a backlog ("À faire") card right above the prompt composer. It mirrors the
 * other two control bars' geometry so the family stays consistent, but wears the
 * primary color to stand apart from the green finish control and the accent
 * launch control. Pressing it is the user's consent to admit the card into the
 * pipeline: the server moves it to "Validé" and arms the cost analysis, which the
 * estimator then picks up on its own.
 */
function ApproveTaskBar({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.validateOuter}>
      <View style={styles.validateInner}>
        <Pressable
          onPress={onPress}
          style={approveBarStyle}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.panel.approveTask")}
          testID="task-approve-bar"
        >
          <ThemedBadgeCheck size={ICON_SIZE.sm} uniProps={primaryForegroundMapping} />
          <Text style={styles.approveText}>{t("tasks.panel.approveTask")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function approveBarStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.approveBar, (hovered || pressed) && styles.approveBarHovered];
}

/**
 * Full-width, deliberately quiet outline bar carrying the single "Archiver"
 * action, shown on a finished ("Terminé"/"Déployé") card right above the prompt
 * composer. It shares the other control bars' geometry but wears a muted outline
 * instead of a filled color: archiving is a low-stakes "file it away" gesture,
 * not a publishing or launching one, so it should never shout. Pressing it hides
 * the card from the board without moving or publishing it.
 */
/**
 * Full-width accent bar carrying "Mettre dans À déployer" — the button twin of
 * dragging a finished card into the publication queue. Pressing it only moves
 * the card into the "À déployer" column; it never publishes and never stamps the
 * card live. The single publish gesture stays the column's "Tout déployer".
 */
function QueueDeployBar({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.validateOuter}>
      <View style={styles.validateInner}>
        <Pressable
          onPress={onPress}
          style={runNowBarStyle}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.panel.queueDeploy")}
          testID="task-queue-deploy-bar"
        >
          <ThemedRocket size={ICON_SIZE.sm} uniProps={accentForegroundMapping} />
          <Text style={styles.runNowText}>{t("tasks.panel.queueDeploy")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ArchiveTaskBar({ onPress }: { onPress: () => void }) {
  const { t } = useTranslation();
  return (
    <View style={styles.validateOuter}>
      <View style={styles.validateInner}>
        <Pressable
          onPress={onPress}
          style={archiveBarStyle}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.panel.archiveTask")}
          testID="task-archive-bar"
        >
          <ThemedArchive size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          <Text style={styles.archiveText}>{t("tasks.panel.archiveTask")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function archiveBarStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.archiveBar, (hovered || pressed) && styles.archiveBarHovered];
}

/**
 * Full-width amber bar carrying the "Redémarrer le moteur" action, offered on a
 * card whose work is LIVE but only takes effect once the daemon restarts. It is
 * the last step of the publication, so it takes the composer slot ahead of the
 * archive bar: publish, restart, then file away — no terminal in between.
 *
 * It wears the warning color, matching the card's "Redémarrage requis" pill, so
 * the promise made on the board and the control that keeps it look like the same
 * thing. Restarting drops every running agent, which is why the caller confirms
 * first (and says how many agents are working) rather than firing on the press.
 */
function RestartDaemonBar({
  onPress,
  onCancel,
  progress,
}: {
  onPress: () => void;
  onCancel: () => void;
  progress: RestartProgress;
}) {
  const { t } = useTranslation();
  const cancellable = isRestartCancellable(progress);
  // While the undo window is open the bar itself becomes the cancel button: one
  // control, one meaning at a time. Everything after that point is unpressable —
  // the daemon is already on its way down.
  const disabled = progress.state !== "idle" && !cancellable;
  const barStyle = useCallback(
    (state: { pressed: boolean; hovered?: boolean }) =>
      restartDaemonBarStyle({ ...state, disabled }),
    [disabled],
  );
  const a11yState = useMemo(() => ({ disabled }), [disabled]);
  const label = restartProgressLabel(progress, t, "tasks.panel.restartDaemon");
  return (
    <View style={styles.validateOuter}>
      <View style={styles.validateInner}>
        <Pressable
          onPress={cancellable ? onCancel : onPress}
          disabled={disabled}
          style={barStyle}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={a11yState}
          testID={cancellable ? "task-restart-daemon-cancel" : "task-restart-daemon-bar"}
        >
          <RestartBarIcon progress={progress} cancellable={cancellable} />
          <Text style={styles.restartDaemonText}>{label}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Undo arrow while it can still be taken back, spinner once it cannot. */
function RestartBarIcon({
  progress,
  cancellable,
}: {
  progress: RestartProgress;
  cancellable: boolean;
}) {
  if (cancellable) {
    return <ThemedUndo size={ICON_SIZE.sm} uniProps={warningForegroundMapping} />;
  }
  if (progress.state === "idle") {
    return <ThemedPower size={ICON_SIZE.sm} uniProps={warningForegroundMapping} />;
  }
  return <ThemedActivityIndicator size="small" uniProps={warningForegroundMapping} />;
}

function restartDaemonBarStyle({
  pressed,
  hovered,
  disabled,
}: {
  pressed: boolean;
  hovered?: boolean;
  disabled?: boolean;
}) {
  return [
    styles.restartDaemonBar,
    (hovered || pressed) && !disabled && styles.restartDaemonBarHovered,
    disabled && styles.restartDaemonBarDisabled,
  ];
}

/**
 * Full-width accent bar carrying the single "Lancer le déploiement" action, shown
 * on a finished ("Terminé") card right above the prompt composer. It mirrors the
 * other control bars' geometry so the family stays consistent, and wears the
 * accent color like the run-now launch control — deploying is the other "put it
 * in motion" gesture. Pressing it hands the card's own agent a deploy-then-confirm
 * prompt; the agent verifies, publishes and moves the card to "Déployé" itself.
 *
 * While a deploy runs (`deployment.state === "running"`) the bar shows a spinner
 * and "Déploiement en cours…" and becomes non-clickable, so a second press can
 * never launch a duplicate deploy. The window closes on its own when the agent
 * goes idle (server-side `watchAgentIdle`), which re-enables the bar or, on
 * success, moves the card to "Déployé" — where this bar is no longer offered.
 */
function DeployTaskBar({
  onPress,
  deployment,
}: {
  onPress: () => void;
  deployment: KanbanTask["deployment"];
}) {
  const { t } = useTranslation();
  const running = deployment?.state === "running";
  const barStyle = useCallback(
    (state: { pressed: boolean; hovered?: boolean }) =>
      deployBarStyle({ ...state, disabled: running }),
    [running],
  );
  const a11yState = useMemo(() => ({ disabled: running }), [running]);
  return (
    <View style={styles.validateOuter}>
      <View style={styles.validateInner}>
        <Pressable
          onPress={onPress}
          disabled={running}
          style={barStyle}
          accessibilityRole="button"
          accessibilityLabel={
            running ? t("tasks.panel.deployRunning") : t("tasks.panel.deployTask")
          }
          accessibilityState={a11yState}
          testID="task-deploy-bar"
        >
          {running ? (
            <ThemedActivityIndicator size="small" uniProps={accentForegroundMapping} />
          ) : (
            <ThemedRocket size={ICON_SIZE.sm} uniProps={accentForegroundMapping} />
          )}
          <Text style={styles.runNowText}>
            {running ? t("tasks.panel.deployRunning") : t("tasks.panel.deployTask")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function deployBarStyle({
  pressed,
  hovered,
  disabled,
}: {
  pressed: boolean;
  hovered?: boolean;
  disabled?: boolean;
}) {
  return [
    styles.runNowBar,
    disabled && styles.barDisabled,
    !disabled && (hovered || pressed) && styles.runNowBarHovered,
  ];
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
  // Shared dimmed look for any action bar that is disabled because its gesture is
  // in progress or not yet legitimate (e.g. finishing while the agent works,
  // deploying while a deploy runs). Kept generic so every bar reads the same.
  barDisabled: {
    opacity: 0.5,
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
  validateSecondary: {
    alignSelf: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  validateSecondaryHovered: {
    backgroundColor: theme.colors.surface1,
  },
  validateSecondaryText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
  // Same geometry as the other two bars, filled with the primary color so the
  // consent control stands apart from the green finish and accent launch bars.
  approveBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    width: "100%",
    paddingVertical: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primary,
  },
  approveBarHovered: {
    opacity: 0.88,
  },
  approveText: {
    color: theme.colors.primaryForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  // Same geometry as the other bars, but a quiet muted outline (no fill): archiving
  // a finished card is a low-stakes filing gesture, not a colored action.
  archiveBar: {
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
    backgroundColor: "transparent",
  },
  archiveBarHovered: {
    backgroundColor: theme.colors.border,
  },
  archiveText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  restartDaemonBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    width: "100%",
    paddingVertical: theme.spacing[2],
    marginBottom: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: `${theme.colors.statusWarning}66`,
    backgroundColor: `${theme.colors.statusWarning}1A`,
  },
  restartDaemonBarHovered: {
    backgroundColor: `${theme.colors.statusWarning}33`,
  },
  restartDaemonBarDisabled: {
    opacity: 0.6,
  },
  restartDaemonText: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
}));

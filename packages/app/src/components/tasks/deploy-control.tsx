import { memo, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import {
  CheckCircle2,
  ChevronDown,
  Rocket,
  RotateCcw,
  Square,
  TriangleAlert,
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { KanbanTask, TaskColumn } from "@/data/tasks";
import type { TaskDeployBatch } from "@getpaseo/protocol/tasks/types";
import { countTasksAwaitingDeploy } from "@/components/tasks/deploy-queue";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  batchProgressRatio,
  batchProgressStep,
  formatBatchProgressStep,
  isRecapWorthShowing,
} from "./deploy-batch-status";

// Re-exported so existing importers (and tests) keep their entry points.
export { batchProgressRatio, isRecapWorthShowing } from "./deploy-batch-status";

const accentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const accentColorMapping = (theme: Theme) => ({ color: theme.colors.accent });
// The glyph sitting ON the solid red square.
const onDangerColorMapping = (theme: Theme) => ({ color: theme.colors.background });
const ThemedRocket = withUnistyles(Rocket);
const ThemedChevron = withUnistyles(ChevronDown);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const ThemedCheck = withUnistyles(CheckCircle2);
const ThemedWarning = withUnistyles(TriangleAlert);
const ThemedClose = withUnistyles(X);
const ThemedReset = withUnistyles(RotateCcw);
const ThemedStop = withUnistyles(Square);

/**
 * The one control at the HEAD of the "À déployer" column — publish button and
 * publication banner fused into a single element that changes state in place.
 *
 * There used to be two stacked things saying the same thing: the accent
 * "Tout déployer (N)" button, and — while a run was on — a separate progress
 * banner right under it. Two blocks for one event, worst of all on a phone where
 * the column is narrow. Now it is ONE surface:
 *
 *   at rest   → the split "Tout déployer (N)" button (publish zone + menu chevron);
 *   pressed   → the same surface becomes the run: spinner, current step, one
 *               progress bar, a stop button — flipped the instant it is pressed,
 *               optimistically, before the daemon's own record lands;
 *   finished  → a "voici ce qui vient d'être mis en ligne" recap, dismissible;
 *   dismissed → back to the button.
 *
 * The morph is a real transformation of one persistent element (its height
 * animates between states), never one component disappearing while another
 * appears. The publication is one build for several cards, so it gets one bar,
 * fed by the board's own batch record — server truth, not a local guess.
 *
 * The menu chevron ("publier en heures creuses") stays reachable in every state.
 */
export const DeployControl = memo(function DeployControl({
  column,
  tasks,
  batch,
  onDeployAll,
  offPeakEnabled,
  onToggleOffPeak,
  onOpenLog,
  onReset,
  onStop,
}: {
  column: TaskColumn;
  tasks: readonly KanbanTask[];
  batch: TaskDeployBatch | null | undefined;
  // Fires the batch publication. May resolve to `false` when the run never
  // actually starts (the confirmation was cancelled, or the daemon refused it),
  // which lets the optimistic morph fall back to the button.
  onDeployAll?: (() => Promise<boolean> | boolean | void) | undefined;
  /** State of the "publier en heures creuses" option, when the host exposes it. */
  offPeakEnabled?: boolean | undefined;
  onToggleOffPeak?: ((next: boolean) => void) | undefined;
  // Opens the publication's own log. The publication is a script, not an agent,
  // so its output IS the window onto the live build.
  onOpenLog?: (() => void) | undefined;
  // "Réinitialiser / Relancer": clears the failed state + residual lock and
  // starts a clean publication. Only offered when the batch actually failed.
  onReset?: (() => void) | undefined;
  // "Arrêter": interrupt the running publication (kill the build, free the lock).
  onStop?: (() => void) | undefined;
}) {
  const dismissedAt = useTasksBoardUiStore((state) => state.dismissedDeployBatchAt);
  const dismiss = useTasksBoardUiStore((state) => state.dismissDeployBatch);
  // Optimistic "the run is starting" flag, flipped on press so the surface morphs
  // at the instant of the tap instead of waiting for the daemon's record. Once the
  // real running batch lands, it takes over and this stops mattering.
  const [starting, setStarting] = useState(false);
  const pending = useMemo(() => countTasksAwaitingDeploy(tasks), [tasks]);
  const realRunning = batch?.state === "running";
  useEffect(() => {
    if (realRunning) {
      setStarting(false);
    }
  }, [realRunning]);
  const running = realRunning || starting;

  const handleDeploy = useCallback(() => {
    if (!onDeployAll) {
      return;
    }
    setStarting(true);
    void (async () => {
      try {
        // Keep the optimistic morph ONLY when the run is confirmed started; a
        // cancelled confirmation or a refused run (false, or a handler that
        // returns nothing) drops back to the button rather than a spinner that
        // would never resolve. Once the daemon's own record lands, the effect
        // above clears this flag and the real batch drives the surface.
        const started = await onDeployAll();
        if (started !== true) {
          setStarting(false);
        }
      } catch {
        setStarting(false);
      }
    })();
  }, [onDeployAll]);

  const handleDismiss = useCallback(
    (event?: GestureResponderEvent) => {
      event?.stopPropagation?.();
      if (batch) {
        dismiss(batch.startedAt);
      }
    },
    [batch, dismiss],
  );

  if (column !== "deployed") {
    return null;
  }

  const recapVisible =
    !running &&
    !!batch &&
    batch.state !== "running" &&
    dismissedAt !== batch.startedAt &&
    isRecapWorthShowing(batch, Date.now());
  let mode: "button" | "running" | "recap";
  if (running) {
    mode = "running";
  } else if (recapVisible) {
    mode = "recap";
  } else {
    mode = "button";
  }

  // Nothing to render at all only when there is no button to show either.
  if (mode === "button" && !onDeployAll) {
    return null;
  }

  // One persistent wrapper at the column head. The state inside it changes and
  // fades in — a transformation of a single element, never one block vanishing
  // while another appears elsewhere. `mode` as the key remounts (and thus
  // re-fades) only on a real state change, not on every board re-render.
  return (
    <View style={styles.header}>
      <Animated.View key={mode} entering={FadeIn.duration(140)}>
        {mode === "button" ? (
          <DeployButton
            pending={pending}
            onDeploy={handleDeploy}
            offPeakEnabled={offPeakEnabled}
            onToggleOffPeak={onToggleOffPeak}
          />
        ) : (
          <DeployStatusCard
            mode={mode}
            batch={batch ?? null}
            realRunning={realRunning}
            pending={pending}
            offPeakEnabled={offPeakEnabled}
            onToggleOffPeak={onToggleOffPeak}
            onOpenLog={onOpenLog}
            onReset={onReset}
            onStop={onStop}
            onDismiss={handleDismiss}
          />
        )}
      </Animated.View>
    </View>
  );
});

/**
 * The rest state: the split "Tout déployer (N)" button — a wide publish zone and
 * a narrow menu chevron, joined inside one accent-filled bar. Empty, the publish
 * zone reads as inert (the menu stays live); a press hands the whole batch off.
 */
function DeployButton({
  pending,
  onDeploy,
  offPeakEnabled,
  onToggleOffPeak,
}: {
  pending: number;
  onDeploy: () => void;
  offPeakEnabled?: boolean | undefined;
  onToggleOffPeak?: ((next: boolean) => void) | undefined;
}) {
  const { t } = useTranslation();
  const idle = pending === 0;
  const actionStyle = useCallback(
    ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.action,
      idle && styles.actionDisabled,
      idle && styles.actionIdle,
      !idle && (hovered || pressed) && styles.actionHovered,
    ],
    [idle],
  );
  const a11yState = useMemo(() => ({ disabled: idle }), [idle]);
  const label = idle
    ? t("tasks.board.deployAllEmpty")
    : t("tasks.board.deployAll", { count: pending });
  return (
    <View style={styles.bar}>
      <Pressable
        onPress={onDeploy}
        disabled={idle}
        style={actionStyle}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={a11yState}
        testID="tasks-deploy-all"
      >
        <ThemedRocket size={ICON_SIZE.sm} uniProps={accentForegroundMapping} />
        <Text style={styles.barText} numberOfLines={1}>
          {label}
        </Text>
      </Pressable>
      {/* The opt-in twin of the button — same batch, same closing restart, fired
          on its own inside the quiet-hours window — tucked behind the chevron so
          it stops crowding the button as a line of text. Off unless asked for. */}
      {onToggleOffPeak ? (
        <>
          <View style={styles.divider} />
          <OffPeakMenu enabled={offPeakEnabled} onToggle={onToggleOffPeak} tone="onAccent" />
        </>
      ) : null}
    </View>
  );
}

/**
 * The active states on the SAME surface: a running publication (spinner, one
 * progress bar, current step, stop) or its finished recap (what went out, or why
 * it did not, plus the reset escape hatch). The menu chevron rides along in the
 * header so "publier en heures creuses" stays reachable here too.
 */
function DeployStatusCard({
  mode,
  batch,
  realRunning,
  pending,
  offPeakEnabled,
  onToggleOffPeak,
  onOpenLog,
  onReset,
  onStop,
  onDismiss,
}: {
  mode: "running" | "recap";
  // The board's raw batch record (finished one in recap, running one otherwise).
  batch: TaskDeployBatch | null;
  // Whether that record is a REAL running batch — false during an optimistic
  // start (pressed, but the daemon has not written its record yet).
  realRunning: boolean;
  pending: number;
  offPeakEnabled?: boolean | undefined;
  onToggleOffPeak?: ((next: boolean) => void) | undefined;
  onOpenLog?: (() => void) | undefined;
  onReset?: (() => void) | undefined;
  onStop?: (() => void) | undefined;
  onDismiss: (event?: GestureResponderEvent) => void;
}) {
  const { t } = useTranslation();
  const running = mode === "running";
  // While running, only a real record backs the header/body; the optimistic
  // start has none yet, so it shows the first phase over the pending count.
  const runningBatch = realRunning ? batch : null;
  const headerBatch = running ? runningBatch : batch;
  const state: TaskDeployBatch["state"] = running ? "running" : (batch?.state ?? "success");
  const count = headerBatch ? headerBatch.taskIds.length : pending;
  return (
    <View style={styles.card} testID="tasks-deploy-batch-banner">
      <View style={styles.cardHeader}>
        <LogPressable style={styles.cardHeaderMain} onOpenLog={onOpenLog}>
          <BatchIcon state={state} />
          <Text style={styles.title} numberOfLines={1}>
            {batchTitle(t, state, count)}
          </Text>
        </LogPressable>
        {onToggleOffPeak ? (
          <OffPeakMenu enabled={offPeakEnabled} onToggle={onToggleOffPeak} tone="muted" />
        ) : null}
        <HeaderControl running={running} onStop={onStop} onDismiss={onDismiss} />
      </View>
      <DeployStatusBody
        running={running}
        batch={running ? runningBatch : batch}
        onOpenLog={onOpenLog}
        onReset={onReset}
      />
    </View>
  );
}

/** The half below the header: live progress while running, the recap once done. */
function DeployStatusBody({
  running,
  batch,
  onOpenLog,
  onReset,
}: {
  running: boolean;
  batch: TaskDeployBatch | null;
  onOpenLog?: (() => void) | undefined;
  onReset?: (() => void) | undefined;
}) {
  if (running) {
    return <RunningBody batch={batch} onOpenLog={onOpenLog} />;
  }
  if (batch) {
    return <BatchRecap batch={batch} onReset={onReset} />;
  }
  return null;
}

/** The live half: one progress bar for the whole run, plus the current step. */
function RunningBody({
  batch,
  onOpenLog,
}: {
  batch: TaskDeployBatch | null;
  onOpenLog?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const phase = batch?.phase ?? "start";
  const ratio = batchProgressRatio({ state: "running", phase });
  const step = batchProgressStep({ state: "running", phase });
  const fillStyle = [styles.progressFill, { width: `${Math.round(ratio * 100)}%` as const }];
  return (
    <LogPressable style={styles.runningBody} onOpenLog={onOpenLog}>
      <View style={styles.progressTrack}>
        <View style={fillStyle} />
      </View>
      <Text style={styles.detail} testID="tasks-deploy-batch-step">
        {formatBatchProgressStep(
          step,
          t(`tasks.board.batchPhase.${phase}`, {
            defaultValue: t("tasks.board.batchPhase.start"),
          }),
        )}
        {batch?.auto ? ` · ${t("tasks.board.batchAuto")}` : ""}
      </Text>
      {batch?.queued ? (
        <Text style={styles.detail} testID="tasks-deploy-batch-queued">
          {t("tasks.board.batchQueued")}
        </Text>
      ) : null}
    </LogPressable>
  );
}

/**
 * The finished-run recap: what went out (or why it did not), plus the
 * "Réinitialiser / Relancer" escape hatch on a failure.
 */
function BatchRecap({
  batch,
  onReset,
}: {
  batch: TaskDeployBatch;
  onReset?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const handleReset = useCallback(
    (event?: GestureResponderEvent) => {
      event?.stopPropagation?.();
      onReset?.();
    },
    [onReset],
  );
  const titles = batch.titles ?? [];
  const failed = batch.state === "failed";
  return (
    <>
      {titles.length > 0 ? <BatchTitleList titles={titles} /> : null}
      {failed && batch.error ? (
        <Text style={styles.error} numberOfLines={3}>
          {batch.error}
        </Text>
      ) : null}
      {failed && onReset ? (
        <Pressable
          style={styles.resetButton}
          onPress={handleReset}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.board.deployResetAction")}
          testID="tasks-deploy-batch-reset"
        >
          <ThemedReset size={ICON_SIZE.sm} uniProps={accentColorMapping} />
          <Text style={styles.resetLabel}>{t("tasks.board.deployResetAction")}</Text>
        </Pressable>
      ) : null}
      {batch.state === "success" && batch.url ? (
        <Text style={styles.link} numberOfLines={1}>
          {batch.url}
        </Text>
      ) : null}
    </>
  );
}

/**
 * The full list of what went out — one line per task, never truncated. Long
 * batches get a bounded, scrollable box so the recap can't push the real cards
 * off-screen, but nothing is hidden.
 */
function BatchTitleList({ titles }: { titles: string[] }) {
  return (
    <ScrollView
      style={styles.titleList}
      contentContainerStyle={styles.titleListContent}
      nestedScrollEnabled
      showsVerticalScrollIndicator
      testID="tasks-deploy-batch-titles"
    >
      {titles.map((title, index) => (
        // Static, render-once recap that is never reordered or filtered, so the
        // index is a stable key and titles alone would collide on duplicates.
        // oxlint-disable-next-line no-array-index-key
        <Text key={`${index}-${title}`} style={styles.detail} numberOfLines={1}>
          {`• ${title}`}
        </Text>
      ))}
    </ScrollView>
  );
}

/**
 * The header's trailing control: "Arrêter" while the run is live (so a stuck
 * build is never a dead end), the dismiss cross once it is over.
 */
function HeaderControl({
  running,
  onStop,
  onDismiss,
}: {
  running: boolean;
  onStop?: (() => void) | undefined;
  onDismiss: (event?: GestureResponderEvent) => void;
}) {
  const { t } = useTranslation();
  if (running) {
    return onStop ? <StopButton onStop={onStop} /> : null;
  }
  return (
    <Pressable
      onPress={onDismiss}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t("common.actions.close")}
      testID="tasks-deploy-batch-dismiss"
    >
      <ThemedClose size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
    </Pressable>
  );
}

/** "Arrêter" — the escape hatch for a running publication. */
function StopButton({ onStop }: { onStop: () => void }) {
  const { t } = useTranslation();
  const handleStop = useCallback(
    (event?: GestureResponderEvent) => {
      event?.stopPropagation?.();
      onStop();
    },
    [onStop],
  );
  return (
    <Pressable
      style={styles.stopButton}
      onPress={handleStop}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t("tasks.board.deployStopAction")}
      testID="tasks-deploy-batch-stop"
    >
      <ThemedStop size={ICON_SIZE.xs} uniProps={onDangerColorMapping} />
    </Pressable>
  );
}

/**
 * The "Options de publication" chevron menu (currently just the off-peak
 * switch), shared by the button bar and the status header so it is reachable in
 * every state. `tone` picks the glyph colour for the surface it sits on.
 */
function OffPeakMenu({
  enabled,
  onToggle,
  tone,
}: {
  enabled?: boolean | undefined;
  onToggle: (next: boolean) => void;
  tone: "onAccent" | "muted";
}) {
  const { t } = useTranslation();
  const handleToggle = useCallback(() => {
    onToggle(enabled !== true);
  }, [onToggle, enabled]);
  const chevronStyle = useCallback(
    ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.chevron,
      (hovered || pressed) && styles.chevronHovered,
    ],
    [],
  );
  const glyphMapping = tone === "onAccent" ? accentForegroundMapping : mutedColorMapping;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={chevronStyle}
        accessibilityRole="button"
        accessibilityLabel={t("tasks.board.deployMenu")}
        testID="tasks-deploy-menu"
      >
        <ThemedChevron size={ICON_SIZE.sm} uniProps={glyphMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" minWidth={260}>
        <DropdownMenuLabel>{t("tasks.board.deployMenu")}</DropdownMenuLabel>
        <DropdownMenuItem
          selected={enabled === true}
          closeOnSelect={false}
          onSelect={handleToggle}
          testID="tasks-deploy-off-peak"
        >
          {t("tasks.board.deployOffPeak")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A region that opens the publication log when the host exposes it, and is a
 * plain View otherwise. Kept small so the header title and the progress body can
 * each be tappable without wrapping the whole card in one Pressable (which would
 * swallow the menu chevron's and stop button's own taps).
 */
function LogPressable({
  onOpenLog,
  style,
  children,
}: {
  onOpenLog?: (() => void) | undefined;
  style?: object;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (!onOpenLog) {
    return <View style={style}>{children}</View>;
  }
  return (
    <Pressable
      style={style}
      onPress={onOpenLog}
      accessibilityRole="button"
      accessibilityLabel={t("tasks.board.batchOpenLog")}
    >
      {children}
    </Pressable>
  );
}

/** Spinner while it runs, then the verdict: a check or a warning. */
function BatchIcon({ state }: { state: TaskDeployBatch["state"] }) {
  if (state === "running") {
    return <ThemedActivityIndicator size="small" uniProps={accentColorMapping} />;
  }
  if (state === "success") {
    return <ThemedCheck size={ICON_SIZE.sm} uniProps={successColorMapping} />;
  }
  return <ThemedWarning size={ICON_SIZE.sm} uniProps={dangerColorMapping} />;
}

function batchTitle(
  t: (key: string, options?: Record<string, unknown>) => string,
  state: TaskDeployBatch["state"],
  count: number,
): string {
  if (state === "running") {
    return t("tasks.board.batchRunning", { count });
  }
  if (state === "success") {
    return t("tasks.board.batchDone", { count });
  }
  return t("tasks.board.batchFailed");
}

const styles = StyleSheet.create((theme) => ({
  // Same horizontal inset and bottom gap as the search toolbar and the card list,
  // so the control lines up with everything else in the column, in both the
  // scrollable and web renderers.
  header: {
    alignSelf: "stretch",
    width: "100%",
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  // Rest state — the split button: one bordered, accent-filled bar holding a wide
  // publish zone and a narrow menu zone, joined by a soft inner divider.
  bar: {
    flexDirection: "row",
    alignItems: "stretch",
    width: "100%",
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
    overflow: "hidden",
  },
  action: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  actionHovered: {
    opacity: 0.88,
  },
  actionDisabled: {
    opacity: 0.6,
  },
  // Nothing waiting: the publish zone stays visible but reads as inert.
  actionIdle: {
    opacity: 0.45,
  },
  barText: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  chevron: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
  },
  chevronHovered: {
    opacity: 0.88,
  },
  divider: {
    width: 1,
    marginVertical: theme.spacing[1],
    backgroundColor: theme.colors.accentForeground,
    opacity: 0.25,
  },
  // Active state — the same surface, now an informational card: neutral fill so
  // the running/recap details read calmly rather than as a second call to action.
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  cardHeaderMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  runningBody: {
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    overflow: "hidden",
    backgroundColor: theme.colors.border,
  },
  progressFill: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.accent,
  },
  // Bounded so a big batch scrolls instead of shoving the real cards down;
  // roughly eight lines fit before the box starts scrolling.
  titleList: {
    maxHeight: 132,
  },
  titleListContent: {
    gap: theme.spacing[1] / 2,
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
  resetButton: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  resetLabel: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.xs,
    fontWeight: "500",
  },
  // A solid red square with a white glyph: the one destructive control on a
  // banner already crowded with words. Its label lives in the accessibility name.
  stopButton: {
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.statusDanger,
  },
  link: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.xs,
  },
}));

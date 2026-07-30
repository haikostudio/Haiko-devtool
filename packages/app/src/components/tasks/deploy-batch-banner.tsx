import { memo, type ReactNode, useCallback } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { CheckCircle2, RotateCcw, TriangleAlert, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TaskColumn } from "@/data/tasks";
import type { TaskDeployBatch } from "@getpaseo/protocol/tasks/types";
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

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerColorMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const accentColorMapping = (theme: Theme) => ({ color: theme.colors.accent });
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const ThemedCheck = withUnistyles(CheckCircle2);
const ThemedWarning = withUnistyles(TriangleAlert);
const ThemedClose = withUnistyles(X);
const ThemedReset = withUnistyles(RotateCcw);

/**
 * What the "À déployer" column shows above its cards:
 *
 * - while a batch runs, ONE progress bar for the whole run (préparation →
 *   contrôles → moteur → site → mise en ligne → redémarrage), because it is
 *   one build for every card;
 * - once it is over, a "voici ce qui vient d'être mis en ligne" recap listing
 *   what went out (or why it did not), dismissible in one tap.
 *
 * Both read the board's own batch record, so every device sees the same run —
 * the progress is not a local animation guessing at what the daemon is doing.
 */
export const DeployBatchBanner = memo(function DeployBatchBanner({
  column,
  batch,
  onOpenLog,
  onReset,
}: {
  column: TaskColumn;
  batch: TaskDeployBatch | null | undefined;
  // Opens the publication's own log. The publication is a script, not an agent,
  // so its output IS the window onto the live build — tapping the banner shows
  // exactly which command is running and what it printed.
  onOpenLog?: (() => void) | undefined;
  // "Réinitialiser / Relancer": clears the failed state + residual lock and
  // starts a clean publication. Only offered when the batch actually failed.
  onReset?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const dismissedAt = useTasksBoardUiStore((state) => state.dismissedDeployBatchAt);
  const dismiss = useTasksBoardUiStore((state) => state.dismissDeployBatch);
  const handleDismiss = useCallback(
    (event?: GestureResponderEvent) => {
      // Don't let the dismiss tap also open the agent when the whole card is
      // pressable (web bubbles the click up to the outer Pressable).
      event?.stopPropagation?.();
      if (batch) {
        dismiss(batch.startedAt);
      }
    },
    [batch, dismiss],
  );
  if (column !== "deployed" || !batch) {
    return null;
  }
  const ratio = batchProgressRatio(batch);
  const step = batchProgressStep(batch);
  const fillStyle = [styles.progressFill, { width: `${Math.round(ratio * 100)}%` as const }];
  const running = batch.state === "running";
  if (!running) {
    if (dismissedAt === batch.startedAt || !isRecapWorthShowing(batch, Date.now())) {
      return null;
    }
  }
  const count = batch.taskIds.length;
  const titles = batch.titles ?? [];
  return (
    <BatchCard onOpenLog={onOpenLog}>
      <View style={styles.header}>
        <BatchIcon state={batch.state} />
        <Text style={styles.title}>{batchTitle(t, batch.state, count)}</Text>
        {running ? null : (
          <Pressable
            onPress={handleDismiss}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t("common.actions.close")}
            testID="tasks-deploy-batch-dismiss"
          >
            <ThemedClose size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          </Pressable>
        )}
      </View>
      {running ? (
        <>
          <View style={styles.progressTrack}>
            <View style={fillStyle} />
          </View>
          <Text style={styles.detail} testID="tasks-deploy-batch-step">
            {formatBatchProgressStep(
              step,
              t(`tasks.board.batchPhase.${batch.phase ?? "start"}`, {
                defaultValue: t("tasks.board.batchPhase.start"),
              }),
            )}
            {batch.auto ? ` · ${t("tasks.board.batchAuto")}` : ""}
          </Text>
          {batch.queued ? (
            <Text style={styles.detail} testID="tasks-deploy-batch-queued">
              {t("tasks.board.batchQueued")}
            </Text>
          ) : null}
        </>
      ) : (
        <BatchRecap batch={batch} titles={titles} onReset={onReset} />
      )}
    </BatchCard>
  );
});

/**
 * The banner's outer surface. When the host can show the publication's log, the
 * whole card is a Pressable that opens it (watch the build/publish live);
 * otherwise it is a plain, non-interactive View.
 */
function BatchCard({
  onOpenLog,
  children,
}: {
  onOpenLog?: (() => void) | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  if (!onOpenLog) {
    return (
      <View style={styles.card} testID="tasks-deploy-batch-banner">
        {children}
      </View>
    );
  }
  return (
    <Pressable
      style={styles.card}
      testID="tasks-deploy-batch-banner"
      onPress={onOpenLog}
      accessibilityRole="button"
      accessibilityLabel={t("tasks.board.batchOpenLog")}
    >
      {children}
    </Pressable>
  );
}

/**
 * The finished-run recap: what went out (or why it did not), plus the
 * "Réinitialiser / Relancer" escape hatch on a failure. Split out of the main
 * banner so the top-level component stays under the complexity ceiling.
 */
function BatchRecap({
  batch,
  titles,
  onReset,
}: {
  batch: TaskDeployBatch;
  titles: string[];
  onReset?: (() => void) | undefined;
}) {
  const { t } = useTranslation();
  const handleReset = useCallback(
    (event?: GestureResponderEvent) => {
      // The banner card is itself pressable (opens the log); keep the reset tap
      // from bubbling up and opening the log instead.
      event?.stopPropagation?.();
      onReset?.();
    },
    [onReset],
  );
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
 * The full list of what went out — one line per task, never truncated. The
 * count in the banner title and the number of lines here come from the same
 * batch record, so "11 mises en ligne" always shows 11 rows. Long batches get a
 * bounded, scrollable box so the recap can't push the real cards off-screen,
 * but nothing is hidden: every title is present and reachable by scrolling.
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
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    marginBottom: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
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
  link: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.xs,
  },
}));

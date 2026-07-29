import { memo, type ReactNode, useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { CheckCircle2, TriangleAlert, X } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TaskColumn } from "@/data/tasks";
import type { TaskDeployBatch } from "@getpaseo/protocol/tasks/types";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { batchProgressRatio, isRecapWorthShowing } from "./deploy-batch-status";

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

/**
 * What the "À déployer" column shows above its cards:
 *
 * - while a batch runs, ONE progress bar for the whole run (sauvegarde →
 *   construction → mise en ligne), because it is one build for every card;
 * - once it is over, a "voici ce qui vient d'être mis en ligne" recap listing
 *   what went out (or why it did not), dismissible in one tap.
 *
 * Both read the board's own batch record, so every device sees the same run —
 * the progress is not a local animation guessing at what the daemon is doing.
 */
export const DeployBatchBanner = memo(function DeployBatchBanner({
  column,
  batch,
  onOpenAgent,
}: {
  column: TaskColumn;
  batch: TaskDeployBatch | null | undefined;
  // Opens the single grouped deploy agent's conversation. The banner is the
  // window onto the live build/publish — tapping it shows the agent at work.
  onOpenAgent?: ((agentId: string) => void) | undefined;
}) {
  const { t } = useTranslation();
  const dismissedAt = useTasksBoardUiStore((state) => state.dismissedDeployBatchAt);
  const dismiss = useTasksBoardUiStore((state) => state.dismissDeployBatch);
  const agentId = batch?.agentId ?? null;
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
  const ratio = useMemo(() => (batch ? batchProgressRatio(batch) : 0), [batch]);
  const fillStyle = useMemo(
    () => [styles.progressFill, { width: `${Math.round(ratio * 100)}%` as const }],
    [ratio],
  );
  if (column !== "deployed" || !batch) {
    return null;
  }
  const running = batch.state === "running";
  if (!running) {
    if (dismissedAt === batch.startedAt || !isRecapWorthShowing(batch, Date.now())) {
      return null;
    }
  }
  const count = batch.taskIds.length;
  const titles = batch.titles ?? [];
  return (
    <BatchCard openAgentId={onOpenAgent ? agentId : null} onOpenAgent={onOpenAgent}>
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
          <Text style={styles.detail}>
            {t(`tasks.board.batchPhase.${batch.phase ?? "start"}`, {
              defaultValue: t("tasks.board.batchPhase.start"),
            })}
            {batch.auto ? ` · ${t("tasks.board.batchAuto")}` : ""}
          </Text>
          {batch.queued ? (
            <Text style={styles.detail} testID="tasks-deploy-batch-queued">
              {t("tasks.board.batchQueued")}
            </Text>
          ) : null}
        </>
      ) : (
        <>
          {titles.length > 0 ? <BatchTitleList titles={titles} /> : null}
          {batch.state === "failed" && batch.error ? (
            <Text style={styles.error} numberOfLines={3}>
              {batch.error}
            </Text>
          ) : null}
          {batch.state === "success" && batch.url ? (
            <Text style={styles.link} numberOfLines={1}>
              {batch.url}
            </Text>
          ) : null}
        </>
      )}
    </BatchCard>
  );
});

/**
 * The banner's outer surface. When the run carries a deploy agent, the whole
 * card is a Pressable that opens its conversation (watch the build/publish
 * live); otherwise it is a plain, non-interactive View — exactly as before.
 */
function BatchCard({
  openAgentId,
  onOpenAgent,
  children,
}: {
  openAgentId: string | null;
  onOpenAgent?: ((agentId: string) => void) | undefined;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => {
    if (onOpenAgent && openAgentId) {
      onOpenAgent(openAgentId);
    }
  }, [onOpenAgent, openAgentId]);
  if (!openAgentId) {
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
      onPress={handleOpen}
      accessibilityRole="button"
      accessibilityLabel={t("tasks.board.batchOpenAgent")}
    >
      {children}
    </Pressable>
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
  link: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.xs,
  },
}));

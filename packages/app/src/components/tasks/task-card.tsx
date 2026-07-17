import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { Bot, GitPullRequest } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { KanbanTask } from "@/data/tasks";
import { StatusBadge } from "@/components/ui/status-badge";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedBot = withUnistyles(Bot);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);

interface TaskCardProps {
  task: KanbanTask;
  onPress: (task: KanbanTask) => void;
  testID?: string;
}

function cardStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.card, (hovered || pressed) && styles.cardHovered];
}

/**
 * A single kanban card: title, tag chips, quota estimate, schedule state,
 * linked-agent marker and PR link. Kept intentionally flat/minimal to match
 * the Paseo surfaces (surface2 card on surface1 column).
 */
export const TaskCard = memo(function TaskCard({ task, onPress, testID }: TaskCardProps) {
  const { t } = useTranslation();

  const handlePress = useCallback(() => {
    onPress(task);
  }, [onPress, task]);

  const approvalPending = task.approval?.state === "pending";

  const scheduleBadge = useMemo(() => {
    if (approvalPending) {
      return <StatusBadge label={t("tasks.approval.pending")} variant="warning" />;
    }
    if (task.planReadyAt) {
      return <StatusBadge label={t("tasks.card.planReady")} variant="success" />;
    }
    const state = task.schedule?.state;
    if (!state) {
      return null;
    }
    if (state === "failed") {
      return <StatusBadge label={t("tasks.schedule.failed")} variant="error" />;
    }
    if (state === "running" || state === "launching") {
      return <StatusBadge label={t("tasks.schedule.running")} variant="success" />;
    }
    if (state === "pending_estimate") {
      return <StatusBadge label={t("tasks.schedule.estimating")} />;
    }
    if (task.schedule?.waitingReason === "quiet_hours") {
      return <StatusBadge label={t("tasks.schedule.awaitingWindow")} />;
    }
    return <StatusBadge label={t("tasks.schedule.awaiting")} />;
  }, [approvalPending, task.planReadyAt, task.schedule?.state, task.schedule?.waitingReason, t]);

  const modelLabel = task.runConfig ? (task.runConfig.model ?? task.runConfig.provider) : null;

  const hasMetaRow = Boolean(
    task.estimate || scheduleBadge || modelLabel || task.links.primaryAgentId || task.links.prUrl,
  );

  return (
    <Pressable
      onPress={handlePress}
      style={cardStyle}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={task.title}
    >
      <Text style={styles.title} numberOfLines={3}>
        {task.title}
      </Text>
      {task.tags.length > 0 ? (
        <View style={styles.tagsRow}>
          {task.tags.map((tag) => (
            <View key={tag} style={styles.tagChip}>
              <Text style={styles.tagText}>{tag}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {hasMetaRow ? (
        <View style={styles.metaRow}>
          {task.estimate ? (
            <Text style={styles.estimateText}>
              {t("tasks.card.quotaEstimate", {
                percent: Math.round(task.estimate.quotaPercent),
              })}
            </Text>
          ) : null}
          {task.estimate?.estimatedMinutes !== undefined ? (
            <Text style={styles.estimateText}>
              {t("tasks.card.duration", { minutes: task.estimate.estimatedMinutes })}
            </Text>
          ) : null}
          {modelLabel ? (
            <View style={styles.tagChip}>
              <Text style={styles.tagText}>{modelLabel}</Text>
            </View>
          ) : null}
          {scheduleBadge}
          {task.links.primaryAgentId ? (
            <ThemedBot size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          ) : null}
          {task.links.prUrl ? <PrChip prUrl={task.links.prUrl} /> : null}
        </View>
      ) : null}
      {task.schedule?.lastError ? (
        <Text style={styles.errorText} numberOfLines={2}>
          {task.schedule.lastError}
        </Text>
      ) : null}
    </Pressable>
  );
});

const PrChip = memo(function PrChip({ prUrl }: { prUrl: string }) {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => {
    void openExternalUrl(prUrl);
  }, [prUrl]);
  return (
    <Pressable
      onPress={handleOpen}
      hitSlop={6}
      accessibilityRole="link"
      accessibilityLabel={t("tasks.card.openPr")}
      style={styles.prChip}
    >
      <ThemedGitPullRequest size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      <Text style={styles.prText}>{t("tasks.card.pr", { number: extractPrNumber(prUrl) })}</Text>
    </Pressable>
  );
});

function extractPrNumber(prUrl: string): string {
  const match = prUrl.match(/\/pull\/(\d+)/);
  return match?.[1] ?? "?";
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  cardHovered: {
    backgroundColor: theme.colors.surface3,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  tagsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  tagChip: {
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  tagText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  estimateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  prChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  prText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
}));

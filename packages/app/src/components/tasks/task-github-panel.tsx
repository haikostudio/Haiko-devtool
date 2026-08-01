import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ExternalLink } from "@/components/ui/external-link";
import { StatusBadge } from "@/components/ui/status-badge";
import type { KanbanTask } from "@/data/tasks";
import {
  buildTaskGitJourney,
  hasForgeLink,
  type TaskGitJourneyStep,
  type TaskGitStepState,
} from "@/components/tasks/task-git-journey";
import { formatMessageTimestamp } from "@/utils/time";

const STATE_VARIANT: Record<TaskGitStepState, "success" | "error" | "warning" | "muted"> = {
  success: "success",
  failed: "error",
  running: "warning",
  pending: "muted",
  none: "muted",
};

/**
 * The card's GitHub encart: branch → commit → envoi → fusion → publication.
 *
 * It answers, from the card itself, "where did my work actually get to?" — a
 * question the columns cannot answer, since "Terminée" is a human verdict on the
 * work and says nothing about whether the branch was merged or the build went
 * out. Every row states one step, its state and its date; a failed step carries
 * the reason it failed, on THIS card, so a merge conflict on one card never
 * reads as the whole batch having failed.
 *
 * Without a GitHub remote the same five rows show, minus the links: the journey
 * is a git fact, the links are a forge convenience.
 */
export function TaskGitHubPanel({ task }: { task: KanbanTask }) {
  const { t } = useTranslation();
  const steps = useMemo(() => buildTaskGitJourney(task), [task]);
  const linked = hasForgeLink(task);
  const repoLabel = task.git?.repo ? `${task.git.repo.owner}/${task.git.repo.name}` : null;

  return (
    <View style={styles.card} testID="task-detail-github-card">
      <View style={styles.header}>
        <Text style={styles.cardTitle}>{t("tasks.git.title")}</Text>
        {repoLabel && task.git?.repo ? (
          <ExternalLink
            href={task.git.repo.webUrl}
            label={repoLabel}
            testID="task-github-repo-link"
          />
        ) : null}
      </View>
      {steps.map((step) => (
        <GitStepRow key={step.id} step={step} />
      ))}
      {linked ? null : <Text style={styles.hint}>{t("tasks.git.noRepo")}</Text>}
    </View>
  );
}

function GitStepRow({ step }: { step: TaskGitJourneyStep }) {
  const { t } = useTranslation();
  const date = step.at ? formatDate(step.at) : null;
  return (
    <View style={styles.row} testID={`task-github-step-${step.id}`}>
      <View style={styles.rowHead}>
        <Text style={styles.stepLabel}>{t(`tasks.git.steps.${step.id}`)}</Text>
        <StatusBadge
          label={t(`tasks.git.states.${step.state}`)}
          variant={STATE_VARIANT[step.state]}
        />
        {date ? <Text style={styles.stepDate}>{date}</Text> : null}
      </View>
      <StepValue step={step} />
      {step.detail ? (
        <Text style={step.state === "failed" ? styles.stepError : styles.stepDetail}>
          {step.detail}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The step's own value: a branch name or a commit id. It becomes a link only
 * when the project's repository is known — the value itself is worth showing
 * either way.
 */
function StepValue({ step }: { step: TaskGitJourneyStep }) {
  if (!step.value) {
    return null;
  }
  if (step.url) {
    return <ExternalLink href={step.url} label={step.value} />;
  }
  return (
    <Text style={styles.stepValue} numberOfLines={1}>
      {step.value}
    </Text>
  );
}

/** A malformed date must never break the encart — it simply shows nothing. */
function formatDate(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return formatMessageTimestamp(parsed);
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
  },
  row: {
    gap: theme.spacing[1],
  },
  rowHead: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  stepLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  stepDate: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  // Branch names and commit ids are technical strings: monospace keeps them
  // readable and stops a long branch from being mistaken for a sentence.
  stepValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
  stepDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  stepError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

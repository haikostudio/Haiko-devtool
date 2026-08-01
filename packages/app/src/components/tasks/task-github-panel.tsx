import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { StatusBadge } from "@/components/ui/status-badge";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
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
export function TaskGitHubPanel({
  task,
  serverId,
  projectId,
}: {
  task: KanbanTask;
  serverId?: string | null;
  projectId?: string | null;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const [busy, setBusy] = useState<"refresh" | "conflict" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const steps = useMemo(() => buildTaskGitJourney(task), [task]);
  const linked = hasForgeLink(task);
  const repoLabel = task.git?.repo ? `${task.git.repo.owner}/${task.git.repo.name}` : null;
  const canAct = Boolean(client && projectId);
  const mergeFailed = steps.some((step) => step.id === "merge" && step.state === "failed");

  // The board push carries the updated card, so neither action stores anything
  // locally: they ask, and the card re-renders when the daemon says so.
  const run = useCallback(
    async (kind: "refresh" | "conflict") => {
      if (!client || !projectId) {
        return;
      }
      setBusy(kind);
      setActionError(null);
      try {
        const payload =
          kind === "refresh"
            ? await client.tasksTaskGitRefresh({ projectId, taskId: task.id })
            : await client.tasksTaskGitResumeConflict({ projectId, taskId: task.id });
        if (payload.error) {
          throw new Error(payload.error);
        }
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
    [client, projectId, task.id],
  );

  const handleRefresh = useCallback(() => void run("refresh"), [run]);
  const handleResumeConflict = useCallback(() => void run("conflict"), [run]);

  return (
    <View style={styles.card} testID="task-detail-github-card">
      <View style={styles.header}>
        <Text style={styles.cardTitle}>{t("tasks.git.title")}</Text>
        <View style={styles.headerActions}>
          {repoLabel && task.git?.repo ? (
            <ExternalLink
              href={task.git.repo.webUrl}
              label={repoLabel}
              testID="task-github-repo-link"
            />
          ) : null}
          {canAct ? (
            <Button
              variant="ghost"
              size="sm"
              onPress={handleRefresh}
              disabled={busy !== null}
              testID="task-github-refresh"
            >
              {busy === "refresh" ? t("tasks.git.refreshing") : t("tasks.git.refresh")}
            </Button>
          ) : null}
        </View>
      </View>
      <BranchSizeLine task={task} />
      {steps.map((step) => (
        <GitStepRow key={step.id} step={step} />
      ))}
      {mergeFailed && canAct ? (
        <Button
          variant="outline"
          size="sm"
          onPress={handleResumeConflict}
          disabled={busy !== null}
          testID="task-github-resume-conflict"
        >
          {busy === "conflict" ? t("tasks.git.resumingConflict") : t("tasks.git.resumeConflict")}
        </Button>
      ) : null}
      {actionError ? <Text style={styles.stepError}>{actionError}</Text> : null}
      {linked ? null : <Text style={styles.hint}>{t("tasks.git.noRepo")}</Text>}
    </View>
  );
}

/**
 * How much the branch carries — commits and files touched. Absent until a read
 * has actually measured it; a "0 fichier" on an unmeasured branch would read as
 * "l'agent n'a rien fait".
 */
function BranchSizeLine({ task }: { task: KanbanTask }) {
  const { t } = useTranslation();
  const { commitCount, changedFiles } = task.git ?? {};
  if (commitCount === undefined && changedFiles === undefined) {
    return null;
  }
  return (
    <Text style={styles.stepDetail} testID="task-github-size">
      {t("tasks.git.size", { commits: commitCount ?? 0, files: changedFiles ?? 0 })}
    </Text>
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
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
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

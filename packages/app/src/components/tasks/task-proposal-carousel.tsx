import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { ListChecks } from "lucide-react-native";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  computeBillableCostChf,
  type EffectiveExecution,
  estimateTokenCostUsd,
  formatChf,
  formatUsd,
  resolveEffectiveExecution,
} from "@/components/tasks/task-cost";
import { useTaskBoard, type KanbanTask, type TaskBoardHandle } from "@/data/tasks";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { TaskTriageProposalRef } from "@/types/stream";

// Matches the triage pill accent in message.tsx.
const TRIAGE_COLOR = "#34d399";
const CARD_WIDTH = 300;

interface TaskProposalCarouselProps {
  serverId: string;
  projectId?: string;
  proposals: TaskTriageProposalRef[];
}

/**
 * Actionable in-chat cards for triage-proposed tasks: one horizontal carousel
 * per triage result, one card per proposed task. Cards render live board state
 * (title/description editable inline, tags, resolved model + reasoning, cost
 * estimates) and let the user approve, refuse (delete) or amend each proposal
 * without leaving the conversation — same spirit as the question-form module.
 */
export function TaskProposalCarousel({
  serverId,
  projectId,
  proposals,
}: TaskProposalCarouselProps) {
  const { t } = useTranslation();
  const board = useTaskBoard(serverId || null, projectId ?? null);
  // Home scope: provider availability does not depend on a checkout.
  const snapshot = useProvidersSnapshot(serverId || null, { cwd: null });

  return (
    <View style={styles.container} testID="task-proposal-carousel">
      <View style={styles.headerRow}>
        <ListChecks size={16} color={TRIAGE_COLOR} />
        <Text style={styles.headerText}>
          {t("tasks.triage.header", { count: proposals.length })}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={CARD_WIDTH + 12}
        decelerationRate="fast"
        contentContainerStyle={styles.scrollContent}
      >
        {proposals.map((proposal) => (
          <TaskProposalCard
            key={proposal.taskId}
            proposal={proposal}
            board={board}
            entries={snapshot.entries}
          />
        ))}
      </ScrollView>
    </View>
  );
}

type CardBusy = "approve" | "refuse" | "save" | null;

interface CardDraft {
  title: string;
  description: string;
}

interface CardView {
  task: KanbanTask | null;
  boardReady: boolean;
  folderName: string | null;
  liveTitle: string;
  liveDescription: string;
}

function deriveCardView(proposal: TaskTriageProposalRef, board: TaskBoardHandle): CardView {
  const task = board.board?.tasks.find((entry) => entry.id === proposal.taskId) ?? null;
  const folderName =
    board.board?.folders.find((folder) => folder.id === task?.folderId)?.name ?? null;
  return {
    task,
    boardReady: board.board !== null,
    folderName,
    liveTitle: task?.title ?? proposal.title,
    liveDescription: task?.description ?? "",
  };
}

function isDraftDirty(draft: CardDraft | null, view: CardView): boolean {
  return (
    draft !== null && (draft.title !== view.liveTitle || draft.description !== view.liveDescription)
  );
}

function resolveTaskEffective(
  entries: ProviderSnapshotEntry[] | undefined,
  task: KanbanTask | null,
): EffectiveExecution {
  return resolveEffectiveExecution({
    entries,
    selection: task?.runConfig
      ? { provider: task.runConfig.provider, model: task.runConfig.model }
      : null,
    thinkingOptionId: task?.runConfig?.thinkingOptionId ?? null,
    mode: task?.runConfig?.mode === "plan" ? "plan" : "direct",
  });
}

interface TaskProposalCardProps {
  proposal: TaskTriageProposalRef;
  board: TaskBoardHandle;
  entries: ProviderSnapshotEntry[] | undefined;
}

function TaskProposalCard({ proposal, board, entries }: TaskProposalCardProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<CardBusy>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // null = untouched; live board values render until the user types.
  const [draft, setDraft] = useState<CardDraft | null>(null);

  const taskId = proposal.taskId;
  const view = deriveCardView(proposal, board);
  const { task, boardReady, folderName, liveTitle, liveDescription } = view;
  const dirty = isDraftDirty(draft, view);

  const effective = useMemo(
    () => resolveTaskEffective(entries, task),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runConfig identity tracks task content
    [entries, task?.runConfig],
  );

  const runAction = useCallback(
    async (kind: Exclude<CardBusy, null>, action: () => Promise<void>) => {
      setBusy(kind);
      setActionError(null);
      try {
        await action();
      } catch (error) {
        setActionError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const handleChangeTitle = useCallback(
    (value: string) => {
      setDraft((current) => ({
        title: value,
        description: current?.description ?? liveDescription,
      }));
    },
    [liveDescription],
  );
  const handleChangeDescription = useCallback(
    (value: string) => {
      setDraft((current) => ({ title: current?.title ?? liveTitle, description: value }));
    },
    [liveTitle],
  );

  const saveDraft = useCallback(async () => {
    if (!draft || !draft.title.trim()) {
      return;
    }
    await board.updateTask({
      taskId,
      title: draft.title.trim(),
      description: draft.description.trim() === "" ? null : draft.description,
    });
    setDraft(null);
  }, [board, draft, taskId]);

  const handleSave = useCallback(() => {
    void runAction("save", saveDraft);
  }, [runAction, saveDraft]);

  const handleApprove = useCallback(() => {
    void runAction("approve", async () => {
      // Approving adopts any pending inline edits first.
      if (dirty) {
        await saveDraft();
      }
      await board.approveTask(taskId);
    });
  }, [runAction, dirty, saveDraft, board, taskId]);

  const handleRefuse = useCallback(() => {
    void runAction("refuse", () => board.deleteTask(taskId));
  }, [runAction, board, taskId]);

  // Board loaded but the task is gone: it was refused (or deleted elsewhere).
  if (boardReady && !task) {
    return (
      <View style={styles.cardRefused}>
        <Text style={styles.titleMuted} numberOfLines={2} selectable>
          {proposal.title}
        </Text>
        <StatusBadge label={t("tasks.triage.refused")} variant="error" />
      </View>
    );
  }

  const pending = task?.approval?.state === "pending";

  return (
    <View style={styles.card} testID={`task-proposal-${taskId}`}>
      <ProposalTitle
        pending={pending}
        title={liveTitle}
        taskId={taskId}
        onChange={handleChangeTitle}
      />
      <ProposalDescription
        pending={pending}
        description={liveDescription}
        taskId={taskId}
        onChange={handleChangeDescription}
      />
      <ProposalMeta folderName={folderName} tags={task?.tags} effective={effective} />
      <ProposalEstimates estimate={task?.estimate ?? null} modelId={effective.modelId} />
      {!boardReady ? (
        <Text style={styles.metaText}>{board.error ?? t("tasks.triage.loading")}</Text>
      ) : null}
      {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}
      {pending ? (
        <ProposalActions
          taskId={taskId}
          busy={busy}
          dirty={dirty}
          onApprove={handleApprove}
          onRefuse={handleRefuse}
          onSave={handleSave}
        />
      ) : (
        <ProposalStatus task={task} />
      )}
    </View>
  );
}

function ProposalTitle({
  pending,
  title,
  taskId,
  onChange,
}: {
  pending: boolean;
  title: string;
  taskId: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  if (!pending) {
    return (
      <Text style={styles.title} numberOfLines={2} selectable>
        {title}
      </Text>
    );
  }
  return (
    <FormTextInput
      size="sm"
      initialValue={title}
      onChangeText={onChange}
      placeholder={t("tasks.newTaskPlaceholder")}
      style={styles.stretchInput}
      testID={`task-proposal-title-${taskId}`}
    />
  );
}

function ProposalDescription({
  pending,
  description,
  taskId,
  onChange,
}: {
  pending: boolean;
  description: string;
  taskId: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  if (!pending) {
    if (!description) {
      return null;
    }
    return (
      <Text style={styles.description} numberOfLines={3} selectable>
        {description}
      </Text>
    );
  }
  return (
    <FormTextInput
      size="sm"
      initialValue={description}
      onChangeText={onChange}
      placeholder={t("tasks.newTaskDescriptionPlaceholder")}
      style={styles.descriptionInput}
      multiline
      numberOfLines={3}
      textAlignVertical="top"
      testID={`task-proposal-description-${taskId}`}
    />
  );
}

function ProposalMeta({
  folderName,
  tags,
  effective,
}: {
  folderName: string | null;
  tags: string[] | undefined;
  effective: EffectiveExecution;
}) {
  const { t } = useTranslation();
  const defaultSuffix = ` ${t("tasks.detail.execution.defaultSuffix")}`;
  return (
    <View style={styles.metaBlock}>
      {folderName ? (
        <Text style={styles.metaText} numberOfLines={1}>
          {t("tasks.triage.folder", { name: folderName })}
        </Text>
      ) : null}
      {tags && tags.length > 0 ? (
        <Text style={styles.metaText} numberOfLines={1}>
          {tags.join(" · ")}
        </Text>
      ) : null}
      <Text style={styles.metaText} numberOfLines={1}>
        {`${t("tasks.detail.execution.effectiveModel", { model: effective.modelLabel })}${
          effective.modelIsDefault ? defaultSuffix : ""
        }`}
      </Text>
      {effective.thinkingLabel ? (
        <Text style={styles.metaText} numberOfLines={1}>
          {`${t("tasks.detail.execution.effectiveThinking", { level: effective.thinkingLabel })}${
            effective.thinkingIsDefault ? defaultSuffix : ""
          }`}
        </Text>
      ) : null}
    </View>
  );
}

function ProposalEstimates({
  estimate,
  modelId,
}: {
  estimate: KanbanTask["estimate"] | null;
  modelId: string | null;
}) {
  const { t } = useTranslation();
  if (!estimate) {
    return null;
  }
  const minutes = estimate.estimatedMinutes;
  return (
    <View style={styles.badgeRow}>
      <StatusBadge
        label={t("tasks.card.quotaEstimate", { percent: Math.round(estimate.quotaPercent) })}
      />
      {minutes !== undefined ? <StatusBadge label={t("tasks.card.duration", { minutes })} /> : null}
      {minutes !== undefined ? (
        <StatusBadge
          label={t("tasks.detail.cost.billable", {
            amount: formatChf(computeBillableCostChf(minutes)),
          })}
        />
      ) : null}
      {modelId ? (
        <StatusBadge
          label={t("tasks.detail.cost.tokens", {
            amount: formatUsd(estimateTokenCostUsd(modelId, estimate.tokens)),
          })}
        />
      ) : null}
    </View>
  );
}

function ProposalActions({
  taskId,
  busy,
  dirty,
  onApprove,
  onRefuse,
  onSave,
}: {
  taskId: string;
  busy: CardBusy;
  dirty: boolean;
  onApprove: () => void;
  onRefuse: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.actionsRow}>
      <Button
        style={styles.actionButton}
        variant="destructive"
        onPress={onRefuse}
        disabled={busy !== null}
        testID={`task-proposal-refuse-${taskId}`}
      >
        {t("tasks.triage.refuse")}
      </Button>
      {dirty ? (
        <Button
          style={styles.actionButton}
          variant="secondary"
          onPress={onSave}
          disabled={busy !== null}
          testID={`task-proposal-save-${taskId}`}
        >
          {t("tasks.triage.save")}
        </Button>
      ) : null}
      <Button
        style={styles.actionButton}
        variant="default"
        onPress={onApprove}
        disabled={busy !== null}
        testID={`task-proposal-approve-${taskId}`}
      >
        {t("tasks.triage.approve")}
      </Button>
    </View>
  );
}

function ProposalStatus({ task }: { task: KanbanTask | null }) {
  const { t } = useTranslation();
  if (!task) {
    return null;
  }
  return <StatusBadge label={t("tasks.triage.approved")} variant="success" />;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
    marginVertical: theme.spacing[2],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerText: {
    color: TRIAGE_COLOR,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  scrollContent: {
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  card: {
    width: CARD_WIDTH,
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    alignItems: "flex-start",
  },
  cardRefused: {
    width: CARD_WIDTH,
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    alignItems: "flex-start",
    opacity: 0.6,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  titleMuted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    textDecorationLine: "line-through",
  },
  stretchInput: {
    alignSelf: "stretch",
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  descriptionInput: {
    minHeight: 64,
    alignSelf: "stretch",
  },
  metaBlock: {
    gap: theme.spacing[1],
    alignSelf: "stretch",
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
  },
  actionsRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    alignSelf: "stretch",
  },
  actionButton: {
    flex: 1,
  },
}));

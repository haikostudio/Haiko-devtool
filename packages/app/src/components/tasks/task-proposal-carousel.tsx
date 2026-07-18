import { useCallback, useMemo, useState } from "react";
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { StyleSheet } from "react-native-unistyles";
import { Check, ListChecks, X } from "lucide-react-native";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  computeBillableCostChf,
  type EffectiveExecution,
  estimateTokenCostUsd,
  formatChf,
  formatUsd,
  resolveEffectiveExecution,
} from "@/components/tasks/task-cost";
import { parseTaskTags } from "@/components/tasks/task-tags";
import { useTaskBoard, type KanbanTask, type TaskBoardHandle } from "@/data/tasks";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { TaskTriageProposalRef } from "@/types/stream";

const CARD_WIDTH = 288;
const CARD_GAP = 12;

// Bespoke deep-violet block palette, independent of the light app theme.
const C = {
  block: "#2E2A63",
  blockBorder: "#4A429A",
  header: "#CBC0FF",
  card: "#39337E",
  cardBorder: "#524BA6",
  text: "#F2EFFF",
  muted: "#B8B0E8",
  label: "#948BD0",
  inputBg: "rgba(255,255,255,0.07)",
  inputBorder: "rgba(255,255,255,0.17)",
  placeholder: "rgba(233,230,255,0.42)",
  chipBg: "rgba(255,255,255,0.10)",
  dot: "rgba(255,255,255,0.26)",
  dotActive: "#CBC0FF",
  approve: "#22C55E",
  refuse: "#F0556B",
  refusedText: "#C9BEFF",
};

interface TaskProposalCarouselProps {
  serverId: string;
  projectId?: string;
  proposals: TaskTriageProposalRef[];
}

/** Connected wrapper: resolves the live board + provider snapshot from the host. */
export function TaskProposalCarousel({
  serverId,
  projectId,
  proposals,
}: TaskProposalCarouselProps) {
  const board = useTaskBoard(serverId || null, projectId ?? null);
  const snapshot = useProvidersSnapshot(serverId || null, { cwd: null });
  return <TaskProposalCards board={board} entries={snapshot.entries} proposals={proposals} />;
}

/**
 * Presentational violet block: header, a horizontal carousel of one detail-rich
 * card per proposed task, and pagination dots. Split from the connected wrapper
 * so it can be previewed with a fabricated board.
 */
export function TaskProposalCards({
  board,
  entries,
  proposals,
}: {
  board: TaskBoardHandle;
  entries: ProviderSnapshotEntry[] | undefined;
  proposals: TaskTriageProposalRef[];
}) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const x = event.nativeEvent.contentOffset.x;
    const index = Math.round(x / (CARD_WIDTH + CARD_GAP));
    setActiveIndex(index < 0 ? 0 : index);
  }, []);

  return (
    <View style={styles.block} testID="task-proposal-carousel">
      <View style={styles.headerRow}>
        <ListChecks size={16} color={C.header} />
        <Text style={styles.headerText}>
          {t("tasks.triage.header", { count: proposals.length })}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        snapToInterval={CARD_WIDTH + CARD_GAP}
        decelerationRate="fast"
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={styles.scrollContent}
      >
        {proposals.map((proposal) => (
          <TaskProposalCard
            key={proposal.taskId}
            proposal={proposal}
            board={board}
            entries={entries}
          />
        ))}
      </ScrollView>
      {proposals.length > 1 ? (
        <PaginationDots count={proposals.length} activeIndex={activeIndex} />
      ) : null}
    </View>
  );
}

function PaginationDots({ count, activeIndex }: { count: number; activeIndex: number }) {
  return (
    <View style={styles.dotsRow}>
      {Array.from({ length: count }, (_, index) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static dot list
          key={index}
          style={index === activeIndex ? styles.dotActive : styles.dot}
        />
      ))}
    </View>
  );
}

type CardBusy = "approve" | "refuse" | null;

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

function TaskProposalCard({
  proposal,
  board,
  entries,
}: {
  proposal: TaskTriageProposalRef;
  board: TaskBoardHandle;
  entries: ProviderSnapshotEntry[] | undefined;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<CardBusy>(null);
  const [draft, setDraft] = useState<CardDraft | null>(null);

  const taskId = proposal.taskId;
  const view = deriveCardView(proposal, board);
  const { task, boardReady, folderName, liveTitle, liveDescription } = view;
  const dirty =
    draft !== null && (draft.title !== liveTitle || draft.description !== liveDescription);
  const effective = useMemo(
    () => resolveTaskEffective(entries, task),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runConfig identity tracks task content
    [entries, task?.runConfig],
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
  }, [board, draft, taskId]);

  const commitOnBlur = useCallback(() => {
    if (dirty) {
      void saveDraft();
    }
  }, [dirty, saveDraft]);

  const handleApprove = useCallback(() => {
    setBusy("approve");
    void (async () => {
      try {
        if (dirty) {
          await saveDraft();
        }
        await board.approveTask(taskId);
      } finally {
        setBusy(null);
      }
    })();
  }, [board, dirty, saveDraft, taskId]);

  const handleRefuse = useCallback(() => {
    setBusy("refuse");
    void board.deleteTask(taskId).finally(() => setBusy(null));
  }, [board, taskId]);

  const changeTitle = useCallback(
    (value: string) =>
      setDraft((current) => ({
        title: value,
        description: current?.description ?? liveDescription,
      })),
    [liveDescription],
  );
  const changeDescription = useCallback(
    (value: string) =>
      setDraft((current) => ({ title: current?.title ?? liveTitle, description: value })),
    [liveTitle],
  );

  // Board loaded but the task is gone: it was refused (or deleted elsewhere).
  if (boardReady && !task) {
    return (
      <View style={styles.cardRefused} testID={`task-proposal-${taskId}`}>
        <X size={15} color={C.refusedText} />
        <Text style={styles.refusedTitle} numberOfLines={2}>
          {proposal.title}
        </Text>
        <Text style={styles.refusedLabel}>{t("tasks.triage.refused")}</Text>
      </View>
    );
  }

  const pending = task?.approval?.state === "pending";

  return (
    <View style={styles.card} testID={`task-proposal-${taskId}`}>
      <View style={styles.cardBody}>
        <LabeledField label={t("tasks.detail.titleField")}>
          {pending ? (
            <TextInput
              style={styles.input}
              value={draft?.title ?? liveTitle}
              onChangeText={changeTitle}
              onBlur={commitOnBlur}
              placeholderTextColor={C.placeholder}
              testID={`task-proposal-title-${taskId}`}
            />
          ) : (
            <Text style={styles.readValue}>{liveTitle}</Text>
          )}
        </LabeledField>

        <LabeledField label={t("tasks.detail.descriptionField")}>
          {pending ? (
            <TextInput
              style={styles.inputMultiline}
              value={draft?.description ?? liveDescription}
              onChangeText={changeDescription}
              onBlur={commitOnBlur}
              placeholder={t("tasks.newTaskDescriptionPlaceholder")}
              placeholderTextColor={C.placeholder}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
              testID={`task-proposal-description-${taskId}`}
            />
          ) : (
            <Text style={styles.readValue}>{liveDescription || "—"}</Text>
          )}
        </LabeledField>

        <CardDetailList task={task} effective={effective} folderName={folderName} />
      </View>

      <CardFooter
        pending={pending}
        approved={task !== null && !pending}
        busy={busy}
        onApprove={handleApprove}
        onRefuse={handleRefuse}
        taskId={taskId}
      />
    </View>
  );
}

function CardFooter({
  pending,
  approved,
  busy,
  onApprove,
  onRefuse,
  taskId,
}: {
  pending: boolean;
  approved: boolean;
  busy: CardBusy;
  onApprove: () => void;
  onRefuse: () => void;
  taskId: string;
}) {
  const { t } = useTranslation();
  if (pending) {
    return (
      <View style={styles.actionsRow}>
        <Pressable
          style={styles.approveBtn}
          onPress={onApprove}
          disabled={busy !== null}
          accessibilityLabel={t("tasks.triage.approve")}
          testID={`task-proposal-approve-${taskId}`}
        >
          <Check size={18} color="#0B2E17" />
        </Pressable>
        <Pressable
          style={styles.refuseBtn}
          onPress={onRefuse}
          disabled={busy !== null}
          accessibilityLabel={t("tasks.triage.refuse")}
          testID={`task-proposal-refuse-${taskId}`}
        >
          <X size={18} color="#3A0B12" />
        </Pressable>
      </View>
    );
  }
  if (approved) {
    return (
      <View style={styles.approvedRow}>
        <Check size={14} color={C.approve} />
        <Text style={styles.approvedText}>{t("tasks.triage.approved")}</Text>
      </View>
    );
  }
  return null;
}

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

function preferenceLabelKey(preference: string): string {
  if (preference === "asap") {
    return "tasks.detail.execution.prefAsap";
  }
  if (preference === "off_peak") {
    return "tasks.detail.execution.prefOffPeak";
  }
  return "tasks.detail.execution.prefAuto";
}

function formatWithDefault(label: string | null, isDefault: boolean, suffix: string): string {
  if (!label) {
    return "—";
  }
  return `${label}${isDefault ? suffix : ""}`;
}

function buildEstimateValue(estimate: KanbanTask["estimate"], t: TFunction): string | null {
  if (!estimate) {
    return null;
  }
  return [
    t("tasks.card.quotaEstimate", { percent: Math.round(estimate.quotaPercent) }),
    estimate.estimatedMinutes !== undefined
      ? t("tasks.card.duration", { minutes: estimate.estimatedMinutes })
      : null,
    `${(estimate.tokens / 1000).toFixed(0)}k tok`,
    estimate.confidence,
  ]
    .filter(Boolean)
    .join(" · ");
}

function buildCostValue(
  estimate: KanbanTask["estimate"],
  effective: EffectiveExecution,
): string | null {
  if (!estimate || estimate.estimatedMinutes === undefined) {
    return null;
  }
  return [
    formatChf(computeBillableCostChf(estimate.estimatedMinutes)),
    effective.modelId ? formatUsd(estimateTokenCostUsd(effective.modelId, estimate.tokens)) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function CardDetailList({
  task,
  effective,
  folderName,
}: {
  task: KanbanTask | null;
  effective: EffectiveExecution;
  folderName: string | null;
}) {
  const { t } = useTranslation();
  const parsed = parseTaskTags(task?.tags ?? []);
  const suffix = ` ${t("tasks.detail.execution.defaultSuffix")}`;
  const modelValue = formatWithDefault(effective.modelLabel, effective.modelIsDefault, suffix);
  const thinkingValue = formatWithDefault(
    effective.thinkingLabel,
    effective.thinkingIsDefault,
    suffix,
  );
  const modeValue =
    effective.mode === "plan"
      ? t("tasks.detail.execution.modePlan")
      : t("tasks.detail.execution.modeDirect");
  const prefValue = t(preferenceLabelKey(task?.schedulePreference ?? "auto"));
  const estimateValue = buildEstimateValue(task?.estimate ?? null, t);
  const costValue = buildCostValue(task?.estimate ?? null, effective);

  return (
    <View style={styles.detailList}>
      {parsed.tags.length > 0 ? (
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>{t("tasks.detail.tagsField")}</Text>
          <View style={styles.chipRow}>
            {parsed.tags.map((tag) => (
              <Text key={tag} style={styles.chip}>
                {tag}
              </Text>
            ))}
          </View>
        </View>
      ) : null}
      {folderName ? <DetailRow label={t("tasks.triage.fieldFolder")} value={folderName} /> : null}
      {parsed.priority ? (
        <DetailRow label={t("tasks.triage.fieldPriority")} value={parsed.priority.label} />
      ) : null}
      {parsed.deadline ? (
        <DetailRow label={t("tasks.triage.fieldDeadline")} value={parsed.deadline.label} />
      ) : null}
      <DetailRow label={t("tasks.detail.execution.model")} value={modelValue} />
      <DetailRow label={t("tasks.detail.execution.thinking")} value={thinkingValue} />
      <DetailRow label={t("tasks.detail.execution.mode")} value={modeValue} />
      <DetailRow label={t("tasks.detail.execution.schedulePreference")} value={prefValue} />
      <DetailRow
        label={t("tasks.triage.fieldEstimate")}
        value={estimateValue ?? t("tasks.triage.pendingEstimate")}
      />
      {costValue ? <DetailRow label={t("tasks.triage.fieldCost")} value={costValue} /> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  block: {
    marginVertical: theme.spacing[2],
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: C.blockBorder,
    backgroundColor: C.block,
    paddingVertical: theme.spacing[3],
    paddingLeft: theme.spacing[3],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingRight: theme.spacing[3],
  },
  headerText: {
    color: C.header,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  scrollContent: {
    gap: CARD_GAP,
    paddingRight: theme.spacing[3],
  },
  card: {
    width: CARD_WIDTH,
    justifyContent: "space-between",
    gap: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: C.cardBorder,
    backgroundColor: C.card,
    padding: theme.spacing[3],
  },
  cardBody: {
    gap: theme.spacing[2],
  },
  cardRefused: {
    width: CARD_WIDTH,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: C.cardBorder,
    backgroundColor: "rgba(255,255,255,0.03)",
    padding: theme.spacing[4],
  },
  refusedTitle: {
    color: C.muted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    textDecorationLine: "line-through",
    textAlign: "center",
  },
  refusedLabel: {
    color: C.refusedText,
    fontSize: theme.fontSize.xs,
  },
  field: {
    gap: 3,
  },
  fieldLabel: {
    color: C.label,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  input: {
    width: "100%",
    color: C.text,
    fontSize: theme.fontSize.sm,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: C.inputBorder,
    backgroundColor: C.inputBg,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  inputMultiline: {
    width: "100%",
    minHeight: 60,
    color: C.text,
    fontSize: theme.fontSize.sm,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: C.inputBorder,
    backgroundColor: C.inputBg,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  readValue: {
    color: C.text,
    fontSize: theme.fontSize.sm,
  },
  detailList: {
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  detailLabel: {
    width: 92,
    color: C.label,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  detailValue: {
    flex: 1,
    color: C.text,
    fontSize: theme.fontSize.xs,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
  },
  chip: {
    color: C.text,
    fontSize: theme.fontSize.xs,
    backgroundColor: C.chipBg,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    overflow: "hidden",
  },
  actionsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  approveBtn: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: C.approve,
  },
  refuseBtn: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: C.refuse,
  },
  approvedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  approvedText: {
    color: C.approve,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  dotsRow: {
    flexDirection: "row",
    alignSelf: "center",
    gap: 6,
    paddingRight: theme.spacing[3],
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: C.dot,
  },
  dotActive: {
    width: 18,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: C.dotActive,
  },
}));

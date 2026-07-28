import { useCallback, useEffect, useMemo, useState } from "react";
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
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import {
  computeBillableCostChf,
  type EffectiveExecution,
  estimateTokenCostUsd,
  formatChf,
  formatUsd,
  resolveEffectiveExecution,
} from "@/components/tasks/task-cost";
import {
  useTaskBoard,
  type KanbanTask,
  type TaskBoardHandle,
  type TaskRunConfig,
  type TaskSchedulePreference,
} from "@/data/tasks";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { TaskTriageProposalRef } from "@/types/stream";

const CARD_WIDTH = 300;
const CARD_GAP = 10;
const DEFAULT_OPTION_ID = "__default__";

interface TaskProposalTrayProps {
  serverId: string;
  projectId?: string;
  proposals: TaskTriageProposalRef[];
}

/**
 * Pinned approval tray for triage-proposed tasks — mounted above the composer
 * (same slot as the question/permission cards), NOT inline in the timeline.
 * Shows one fully-editable card per still-pending proposal and disappears once
 * every proposal has been approved or refused.
 */
export function TaskProposalTray({ serverId, projectId, proposals }: TaskProposalTrayProps) {
  const board = useTaskBoard(serverId || null, projectId ?? null);
  // Home scope: provider availability does not depend on a checkout.
  const snapshot = useProvidersSnapshot(serverId || null, { cwd: null });

  const pending = useMemo(() => {
    if (!board.board) {
      return [];
    }
    const byId = new Map(board.board.tasks.map((task) => [task.id, task]));
    return proposals.filter((ref) => byId.get(ref.taskId)?.approval?.state === "pending");
  }, [board.board, proposals]);

  if (pending.length === 0) {
    return null;
  }
  return <TaskProposalCards board={board} entries={snapshot.entries} proposals={pending} />;
}

/**
 * Presentational block styled like the chat surface (light/dark via theme
 * tokens): header, horizontal carousel of one card per task, pagination dots.
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
  // Multi-select for bulk approval. A card's per-card Approve/Refuse buttons
  // still work independently; ticking cards here only feeds the "approve
  // selected" bar. Card edits are saved on blur (updateTask), so a bulk approve
  // simply approves the already-persisted proposals.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // Drop selections whose proposal has left the pending set (approved or
  // refused elsewhere) so the count and the "approve selected" bar stay honest.
  useEffect(() => {
    const live = new Set(proposals.map((proposal) => proposal.taskId));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [proposals]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const x = event.nativeEvent.contentOffset.x;
    const index = Math.round(x / (CARD_WIDTH + CARD_GAP));
    setActiveIndex(index < 0 ? 0 : index);
  }, []);

  const toggleSelect = useCallback((taskId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }, []);

  const allSelected = proposals.length > 0 && selected.size === proposals.length;
  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === proposals.length ? new Set() : new Set(proposals.map((p) => p.taskId)),
    );
  }, [proposals]);

  const approveSelected = useCallback(() => {
    const ids = proposals.map((p) => p.taskId).filter((id) => selected.has(id));
    if (ids.length === 0) {
      return;
    }
    setBulkBusy(true);
    void (async () => {
      try {
        // Sequential so a mid-batch failure leaves the rest still pending in the
        // tray rather than half-applying under a single rejected promise.
        for (const id of ids) {
          await board.approveTask(id);
        }
      } finally {
        setBulkBusy(false);
      }
    })();
  }, [board, proposals, selected]);

  return (
    <View style={styles.block} testID="task-proposal-carousel">
      <View style={styles.headerRow}>
        <View style={styles.headerLeft}>
          <ListChecks size={15} color={styles.headerText.color as string} />
          <Text style={styles.headerText}>
            {t("tasks.triage.header", { count: proposals.length })}
          </Text>
        </View>
        {proposals.length > 1 ? (
          <Pressable
            onPress={toggleAll}
            accessibilityRole="button"
            testID="task-proposal-select-all"
          >
            <Text style={styles.selectAllText}>
              {allSelected ? t("tasks.triage.clearSelection") : t("tasks.triage.selectAll")}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {selected.size > 0 ? (
        <View style={styles.bulkRow}>
          <Pressable
            style={styles.approveBtn}
            onPress={approveSelected}
            disabled={bulkBusy}
            accessibilityRole="button"
            testID="task-proposal-approve-selected"
          >
            <Check size={15} color="#ffffff" />
            <Text style={styles.actionText}>
              {t("tasks.triage.approveSelected", { count: selected.size })}
            </Text>
          </Pressable>
        </View>
      ) : null}
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
            selected={selected.has(proposal.taskId)}
            onToggleSelect={toggleSelect}
          />
        ))}
      </ScrollView>
      {proposals.length > 1 ? (
        <View style={styles.dotsRow}>
          {proposals.map((proposal, index) => (
            <View
              key={proposal.taskId}
              style={index === activeIndex ? styles.dotActive : styles.dot}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

interface ModelSelection {
  provider: string;
  model?: string;
}

interface ExecState {
  modelSelection: ModelSelection | null;
  thinkingOptionId: string | null;
  mode: "direct" | "plan";
  schedulePreference: TaskSchedulePreference;
}

function execStateFromTask(task: KanbanTask | null): ExecState {
  return {
    modelSelection: task?.runConfig
      ? { provider: task.runConfig.provider, model: task.runConfig.model }
      : null,
    thinkingOptionId: task?.runConfig?.thinkingOptionId ?? null,
    mode: task?.runConfig?.mode ?? "direct",
    schedulePreference: task?.schedulePreference ?? "auto",
  };
}

function buildRunConfig(state: ExecState): TaskRunConfig | null {
  if (state.modelSelection) {
    return {
      provider: state.modelSelection.provider,
      ...(state.modelSelection.model ? { model: state.modelSelection.model } : {}),
      ...(state.thinkingOptionId ? { thinkingOptionId: state.thinkingOptionId } : {}),
      ...(state.mode === "plan" ? { mode: "plan" as const } : {}),
    };
  }
  if (state.thinkingOptionId || state.mode === "plan") {
    // Explicit reasoning/mode without a model still needs a runConfig carrier.
    return {
      provider: "claude",
      ...(state.thinkingOptionId ? { thinkingOptionId: state.thinkingOptionId } : {}),
      ...(state.mode === "plan" ? { mode: "plan" as const } : {}),
    };
  }
  return null;
}

function modelSelectionKey(value: ModelSelection | null): string {
  return value ? `${value.provider}/${value.model ?? "default"}` : DEFAULT_OPTION_ID;
}

function preferenceLabelKey(preference: TaskSchedulePreference): string {
  if (preference === "asap") {
    return "tasks.detail.execution.prefAsap";
  }
  if (preference === "off_peak") {
    return "tasks.detail.execution.prefOffPeak";
  }
  return "tasks.detail.execution.prefAuto";
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

function TaskProposalCard({
  proposal,
  board,
  entries,
  selected,
  onToggleSelect,
}: {
  proposal: TaskTriageProposalRef;
  board: TaskBoardHandle;
  entries: ProviderSnapshotEntry[] | undefined;
  selected: boolean;
  onToggleSelect: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const taskId = proposal.taskId;
  const task = board.board?.tasks.find((entry) => entry.id === taskId) ?? null;
  const folderName =
    board.board?.folders.find((folder) => folder.id === task?.folderId)?.name ?? null;

  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(task?.title ?? proposal.title);
  const [description, setDescription] = useState(task?.description ?? "");
  const [tagsText, setTagsText] = useState((task?.tags ?? []).join(", "));
  const [exec, setExec] = useState<ExecState>(() => execStateFromTask(task));

  const effective = useMemo(
    () =>
      resolveEffectiveExecution({
        entries,
        selection: exec.modelSelection,
        thinkingOptionId: exec.thinkingOptionId,
        mode: exec.mode,
      }),
    [entries, exec],
  );

  const saveText = useCallback(() => {
    if (!title.trim()) {
      return;
    }
    void board.updateTask({
      taskId,
      title: title.trim(),
      description: description.trim() === "" ? null : description,
      tags: tagsText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
  }, [board, taskId, title, description, tagsText]);

  const applyExec = useCallback(
    (next: ExecState) => {
      setExec(next);
      void board.updateTask({
        taskId,
        runConfig: buildRunConfig(next),
        schedulePreference: next.schedulePreference === "auto" ? null : next.schedulePreference,
      });
    },
    [board, taskId],
  );

  const handleApprove = useCallback(() => {
    setBusy(true);
    void (async () => {
      try {
        saveText();
        await board.approveTask(taskId);
      } finally {
        setBusy(false);
      }
    })();
  }, [board, saveText, taskId]);

  const handleRefuse = useCallback(() => {
    setBusy(true);
    void board.deleteTask(taskId).finally(() => setBusy(false));
  }, [board, taskId]);

  const handleToggleSelect = useCallback(() => onToggleSelect(taskId), [onToggleSelect, taskId]);
  const selectState = useMemo(() => ({ checked: selected }), [selected]);

  return (
    <View style={styles.card} testID={`task-proposal-${taskId}`}>
      <LabeledInput
        label={t("tasks.detail.titleField")}
        value={title}
        onChangeText={setTitle}
        onBlur={saveText}
        testID={`task-proposal-title-${taskId}`}
      />
      <LabeledInput
        label={t("tasks.detail.descriptionField")}
        value={description}
        onChangeText={setDescription}
        onBlur={saveText}
        placeholder={t("tasks.newTaskDescriptionPlaceholder")}
        multiline
        testID={`task-proposal-description-${taskId}`}
      />
      <LabeledInput
        label={t("tasks.detail.tagsField")}
        value={tagsText}
        onChangeText={setTagsText}
        onBlur={saveText}
        placeholder={t("tasks.detail.tagsPlaceholder")}
        testID={`task-proposal-tags-${taskId}`}
      />

      <ExecSelects entries={entries} exec={exec} effective={effective} onChange={applyExec} />

      <CardInfo task={task} effective={effective} folderName={folderName} />

      <View style={styles.actionsRow}>
        <Pressable
          style={selected ? styles.checkboxOn : styles.checkboxOff}
          onPress={handleToggleSelect}
          accessibilityRole="checkbox"
          accessibilityState={selectState}
          accessibilityLabel={t("tasks.triage.select")}
          testID={`task-proposal-select-${taskId}`}
        >
          {selected ? <Check size={12} color="#ffffff" /> : null}
        </Pressable>
        <Pressable
          style={styles.approveBtn}
          onPress={handleApprove}
          disabled={busy}
          accessibilityLabel={t("tasks.triage.approve")}
          testID={`task-proposal-approve-${taskId}`}
        >
          <Check size={15} color="#ffffff" />
          <Text style={styles.actionText}>{t("tasks.triage.approve")}</Text>
        </Pressable>
        <Pressable
          style={styles.refuseBtn}
          onPress={handleRefuse}
          disabled={busy}
          accessibilityLabel={t("tasks.triage.refuse")}
          testID={`task-proposal-refuse-${taskId}`}
        >
          <X size={15} color={styles.refuseText.color as string} />
          <Text style={styles.refuseText}>{t("tasks.triage.refuse")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function LabeledInput({
  label,
  value,
  onChangeText,
  onBlur,
  placeholder,
  multiline,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  onBlur: () => void;
  placeholder?: string;
  multiline?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={multiline ? styles.inputMultiline : styles.input}
        value={value}
        onChangeText={onChangeText}
        onBlur={onBlur}
        placeholder={placeholder}
        placeholderTextColor={styles.placeholderColor.color as string}
        multiline={multiline}
        textAlignVertical={multiline ? "top" : "center"}
        testID={testID}
      />
    </View>
  );
}

function ExecSelects({
  entries,
  exec,
  effective,
  onChange,
}: {
  entries: ProviderSnapshotEntry[] | undefined;
  exec: ExecState;
  effective: EffectiveExecution;
  onChange: (next: ExecState) => void;
}) {
  const { t } = useTranslation();

  const modelOptions = useMemo((): SelectFieldOption<ModelSelection | null>[] => {
    const options: SelectFieldOption<ModelSelection | null>[] = [
      { id: DEFAULT_OPTION_ID, value: null, label: t("tasks.detail.execution.modelDefault") },
    ];
    for (const entry of entries ?? []) {
      if (!entry.enabled || !entry.models || entry.models.length === 0) {
        continue;
      }
      for (const model of entry.models) {
        options.push({
          id: `${entry.provider}/${model.id}`,
          value: { provider: entry.provider, model: model.id },
          label: model.label,
          description: entry.label ?? entry.provider,
        });
      }
    }
    return options;
  }, [entries, t]);

  const selectedModelDefinition = useMemo(() => {
    const entry = entries?.find((item) => item.provider === effective.provider);
    return entry?.models?.find((model) => model.id === effective.modelId) ?? null;
  }, [entries, effective.provider, effective.modelId]);

  const thinkingOptions = useMemo((): SelectFieldOption<string | null>[] => {
    const options: SelectFieldOption<string | null>[] = [
      { id: DEFAULT_OPTION_ID, value: null, label: t("tasks.detail.execution.thinkingDefault") },
    ];
    for (const option of selectedModelDefinition?.thinkingOptions ?? []) {
      options.push({ id: option.id, value: option.id, label: option.label });
    }
    return options;
  }, [selectedModelDefinition, t]);

  const modeOptions = useMemo(
    (): SelectFieldOption<"direct" | "plan">[] => [
      { id: "direct", value: "direct", label: t("tasks.detail.execution.modeDirect") },
      { id: "plan", value: "plan", label: t("tasks.detail.execution.modePlan") },
    ],
    [t],
  );

  const prefOptions = useMemo(
    (): SelectFieldOption<TaskSchedulePreference>[] => [
      { id: "auto", value: "auto", label: t("tasks.detail.execution.prefAuto") },
      { id: "asap", value: "asap", label: t("tasks.detail.execution.prefAsap") },
      { id: "off_peak", value: "off_peak", label: t("tasks.detail.execution.prefOffPeak") },
    ],
    [t],
  );

  const suffix = ` ${t("tasks.detail.execution.defaultSuffix")}`;
  const modelDisplay = useMemo(
    () => ({ label: `${effective.modelLabel}${effective.modelIsDefault ? suffix : ""}` }),
    [effective.modelLabel, effective.modelIsDefault, suffix],
  );
  const thinkingDisplay = useMemo(
    () => ({
      label: effective.thinkingLabel
        ? `${effective.thinkingLabel}${effective.thinkingIsDefault ? suffix : ""}`
        : t("tasks.detail.execution.thinkingDefault"),
    }),
    [effective.thinkingLabel, effective.thinkingIsDefault, suffix, t],
  );
  const modeDisplay = useMemo(
    () => ({
      label:
        exec.mode === "plan"
          ? t("tasks.detail.execution.modePlan")
          : t("tasks.detail.execution.modeDirect"),
    }),
    [exec.mode, t],
  );
  const prefDisplay = useMemo(
    () => ({ label: t(preferenceLabelKey(exec.schedulePreference)) }),
    [exec.schedulePreference, t],
  );

  const selectModel = useCallback(
    (value: ModelSelection | null) =>
      // Thinking option ids are model-specific; reset on model change.
      onChange({ ...exec, modelSelection: value, thinkingOptionId: null }),
    [exec, onChange],
  );
  const selectThinking = useCallback(
    (value: string | null) => onChange({ ...exec, thinkingOptionId: value }),
    [exec, onChange],
  );
  const selectMode = useCallback(
    (value: "direct" | "plan") => onChange({ ...exec, mode: value }),
    [exec, onChange],
  );
  const selectPref = useCallback(
    (value: TaskSchedulePreference) => onChange({ ...exec, schedulePreference: value }),
    [exec, onChange],
  );

  return (
    <View style={styles.selectStack}>
      <SelectField
        label={t("tasks.detail.execution.model")}
        value={exec.modelSelection}
        selectedDisplay={modelDisplay}
        options={modelOptions}
        onChange={selectModel}
        placeholder={t("tasks.detail.execution.modelDefault")}
        emptyText={t("tasks.detail.execution.noModels")}
        searchable
        size="sm"
        getValueKey={modelSelectionKey}
        testID="task-proposal-model"
      />
      <SelectField
        label={t("tasks.detail.execution.thinking")}
        value={exec.thinkingOptionId}
        selectedDisplay={thinkingDisplay}
        options={thinkingOptions}
        onChange={selectThinking}
        placeholder={t("tasks.detail.execution.thinkingDefault")}
        emptyText={t("tasks.detail.execution.thinkingDefault")}
        size="sm"
        testID="task-proposal-thinking"
      />
      <SelectField
        label={t("tasks.detail.execution.mode")}
        value={exec.mode}
        selectedDisplay={modeDisplay}
        options={modeOptions}
        onChange={selectMode}
        placeholder={t("tasks.detail.execution.modeDirect")}
        emptyText={t("tasks.detail.execution.modeDirect")}
        size="sm"
        testID="task-proposal-mode"
      />
      <SelectField
        label={t("tasks.detail.execution.schedulePreference")}
        value={exec.schedulePreference}
        selectedDisplay={prefDisplay}
        options={prefOptions}
        onChange={selectPref}
        placeholder={t("tasks.detail.execution.prefAuto")}
        emptyText={t("tasks.detail.execution.prefAuto")}
        size="sm"
        testID="task-proposal-preference"
      />
    </View>
  );
}

function CardInfo({
  task,
  effective,
  folderName,
}: {
  task: KanbanTask | null;
  effective: EffectiveExecution;
  folderName: string | null;
}) {
  const { t } = useTranslation();
  const estimateValue = buildEstimateValue(task?.estimate ?? null, t);
  const costValue = buildCostValue(task?.estimate ?? null, effective);
  return (
    <View style={styles.infoBlock}>
      {folderName ? (
        <Text style={styles.infoText} numberOfLines={1}>
          {t("tasks.triage.fieldFolder")} : {folderName}
        </Text>
      ) : null}
      <Text style={styles.infoText} numberOfLines={1}>
        {t("tasks.triage.fieldEstimate")} : {estimateValue ?? t("tasks.triage.pendingEstimate")}
      </Text>
      {costValue ? (
        <Text style={styles.infoText} numberOfLines={1}>
          {t("tasks.triage.fieldCost")} : {costValue}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  block: {
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    marginBottom: theme.spacing[2],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingRight: theme.spacing[3],
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
  },
  headerText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  selectAllText: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  bulkRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: theme.spacing[3],
  },
  checkboxOn: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.statusSuccess,
  },
  checkboxOff: {
    width: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  scrollContent: {
    gap: CARD_GAP,
    paddingRight: theme.spacing[3],
  },
  card: {
    width: CARD_WIDTH,
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.background,
    padding: theme.spacing[3],
  },
  field: {
    gap: theme.spacing[1],
  },
  fieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    width: "100%",
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  inputMultiline: {
    width: "100%",
    minHeight: 52,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  placeholderColor: {
    color: theme.colors.foregroundMuted,
  },
  selectStack: {
    gap: theme.spacing[2],
  },
  infoBlock: {
    gap: theme.spacing[1],
  },
  infoText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  approveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.statusSuccess,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  actionText: {
    color: "#ffffff",
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  refuseBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  refuseText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  dotsRow: {
    flexDirection: "row",
    alignSelf: "center",
    gap: theme.spacing[1.5],
    paddingRight: theme.spacing[3],
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.border,
  },
  dotActive: {
    width: 16,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foreground,
  },
}));

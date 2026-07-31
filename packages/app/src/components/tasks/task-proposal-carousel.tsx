import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Check, ListChecks, X } from "lucide-react-native";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { type EffectiveExecution, resolveEffectiveExecution } from "@/components/tasks/task-cost";
import {
  useTaskBoard,
  type TaskBoardHandle,
  type TaskRunConfig,
  type TaskSchedulePreference,
} from "@/data/tasks";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { TaskTriageProposalRef } from "@/types/stream";

const CARD_WIDTH = 300;
const CARD_GAP = 10;
const DEFAULT_OPTION_ID = "__default__";

// Stable identity for a proposal: its proposalId when present (the deferred-
// creation key), else the legacy board task id, else the title as a last resort.
function refKey(ref: TaskTriageProposalRef): string {
  return ref.proposalId ?? ref.taskId ?? ref.title;
}

interface ProposalPayloadOverride {
  title: string;
  description?: string;
  tags?: string[];
  runConfig?: TaskRunConfig;
}

// Approve a proposal through the SINGLE creation path: new proposals resolve via
// the idempotent RPC (creating exactly one "À faire" task); legacy pills that
// still carry a pre-created board task id fall back to the old approve path.
async function approveProposal(
  board: TaskBoardHandle,
  proposal: TaskTriageProposalRef,
  override?: ProposalPayloadOverride,
): Promise<void> {
  if (proposal.proposalId) {
    const payload: ProposalPayloadOverride = override ?? {
      title: proposal.title,
      ...(proposal.description ? { description: proposal.description } : {}),
      ...(proposal.tags && proposal.tags.length > 0 ? { tags: proposal.tags } : {}),
      ...(proposal.runConfig ? { runConfig: proposal.runConfig } : {}),
    };
    await board.resolveProposal({
      proposalId: proposal.proposalId,
      outcome: "approve",
      proposal: {
        ...payload,
        ...(proposal.folderName ? { folderName: proposal.folderName } : {}),
      },
    });
    return;
  }
  if (proposal.taskId) {
    await board.approveTask(proposal.taskId);
  }
}

// Refuse a proposal: new proposals record a refusal (nothing on the board);
// legacy pills delete their pre-created board task.
async function refuseProposal(
  board: TaskBoardHandle,
  proposal: TaskTriageProposalRef,
): Promise<void> {
  if (proposal.proposalId) {
    await board.resolveProposal({ proposalId: proposal.proposalId, outcome: "refuse" });
    return;
  }
  if (proposal.taskId) {
    await board.deleteTask(proposal.taskId);
  }
}

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
    // A proposal is created ONLY on approval, so a proposal is "still pending"
    // until the board records a resolution (approved/refused) for its id. Legacy
    // pills (no proposalId) still point at a pre-created board task, so they fall
    // back to the old "task exists and is pending approval" test.
    const resolved = new Set(
      (board.board?.proposalResolutions ?? []).map((entry) => entry.proposalId),
    );
    const byId = new Map((board.board?.tasks ?? []).map((task) => [task.id, task]));
    return proposals.filter((ref) => {
      if (ref.proposalId) {
        return !resolved.has(ref.proposalId);
      }
      return ref.taskId ? byId.get(ref.taskId)?.approval?.state === "pending" : false;
    });
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
  // selected" bar. Bulk approves each proposal AS PROPOSED (per-card edits live
  // in each card's local state), creating one "À faire" task apiece.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // Drop selections whose proposal has left the pending set (approved or
  // refused elsewhere) so the count and the "approve selected" bar stay honest.
  useEffect(() => {
    const live = new Set(proposals.map(refKey));
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
      prev.size === proposals.length ? new Set() : new Set(proposals.map(refKey)),
    );
  }, [proposals]);

  const approveSelected = useCallback(() => {
    const chosen = proposals.filter((proposal) => selected.has(refKey(proposal)));
    if (chosen.length === 0) {
      return;
    }
    setBulkBusy(true);
    void (async () => {
      try {
        // Sequential so a mid-batch failure leaves the rest still pending in the
        // tray rather than half-applying under a single rejected promise. Bulk
        // approves the proposal AS PROPOSED (per-card edits live in each card).
        for (const proposal of chosen) {
          await approveProposal(board, proposal);
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
            key={refKey(proposal)}
            proposal={proposal}
            board={board}
            entries={entries}
            selected={selected.has(refKey(proposal))}
            onToggleSelect={toggleSelect}
          />
        ))}
      </ScrollView>
      {proposals.length > 1 ? (
        <View style={styles.dotsRow}>
          {proposals.map((proposal, index) => (
            <View
              key={refKey(proposal)}
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

function execStateFromRunConfig(runConfig: TaskRunConfig | undefined): ExecState {
  return {
    modelSelection: runConfig ? { provider: runConfig.provider, model: runConfig.model } : null,
    thinkingOptionId: runConfig?.thinkingOptionId ?? null,
    mode: runConfig?.mode ?? "direct",
    schedulePreference: "auto",
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

// idle → the two actions are live; approving/refusing → both disabled, a loader
// on the pressed button; error → the operation failed, buttons live again so the
// user can retry. On success the resolution lands on the board and the tray drops
// this card, so there is no lingering "done" state to model here.
type ProposalActionState =
  | { kind: "idle" }
  | { kind: "approving" }
  | { kind: "refusing" }
  | { kind: "error"; message: string };

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
  onToggleSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  const key = refKey(proposal);

  // A proposal is not on the board yet — everything the user edits lives here
  // until they approve, and only then is a single "À faire" task created.
  const [action, setAction] = useState<ProposalActionState>({ kind: "idle" });
  const [title, setTitle] = useState(proposal.title);
  const [description, setDescription] = useState(proposal.description ?? "");
  const [tagsText, setTagsText] = useState((proposal.tags ?? []).join(", "));
  const [exec, setExec] = useState<ExecState>(() => execStateFromRunConfig(proposal.runConfig));

  const busy = action.kind === "approving" || action.kind === "refusing";

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

  const handleApprove = useCallback(() => {
    if (busy) {
      return;
    }
    setAction({ kind: "approving" });
    void (async () => {
      try {
        const tags = tagsText
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean);
        const runConfig = buildRunConfig(exec);
        await approveProposal(board, proposal, {
          title: title.trim() || proposal.title,
          ...(description.trim() ? { description } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(runConfig ? { runConfig } : {}),
        });
        // Success: the board records the resolution and the tray drops this card.
      } catch (error) {
        setAction({ kind: "error", message: (error as Error).message });
      }
    })();
  }, [board, busy, proposal, title, description, tagsText, exec]);

  const handleRefuse = useCallback(() => {
    if (busy) {
      return;
    }
    setAction({ kind: "refusing" });
    void (async () => {
      try {
        await refuseProposal(board, proposal);
      } catch (error) {
        setAction({ kind: "error", message: (error as Error).message });
      }
    })();
  }, [board, busy, proposal]);

  const handleToggleSelect = useCallback(() => onToggleSelect(key), [onToggleSelect, key]);
  const selectState = useMemo(() => ({ checked: selected }), [selected]);

  return (
    <View style={styles.card} testID={`task-proposal-${key}`}>
      <LabeledInput
        label={t("tasks.detail.titleField")}
        value={title}
        onChangeText={setTitle}
        testID={`task-proposal-title-${key}`}
      />
      <LabeledInput
        label={t("tasks.detail.descriptionField")}
        value={description}
        onChangeText={setDescription}
        placeholder={t("tasks.newTaskDescriptionPlaceholder")}
        multiline
        testID={`task-proposal-description-${key}`}
      />
      <LabeledInput
        label={t("tasks.detail.tagsField")}
        value={tagsText}
        onChangeText={setTagsText}
        placeholder={t("tasks.detail.tagsPlaceholder")}
        testID={`task-proposal-tags-${key}`}
      />

      <ExecSelects entries={entries} exec={exec} effective={effective} onChange={setExec} />

      {action.kind === "error" ? (
        <Text style={styles.errorText} testID={`task-proposal-error-${key}`}>
          {action.message}
        </Text>
      ) : null}

      <View style={styles.actionsRow}>
        <Pressable
          style={selected ? styles.checkboxOn : styles.checkboxOff}
          onPress={handleToggleSelect}
          disabled={busy}
          accessibilityRole="checkbox"
          accessibilityState={selectState}
          accessibilityLabel={t("tasks.triage.select")}
          testID={`task-proposal-select-${key}`}
        >
          {selected ? <Check size={12} color="#ffffff" /> : null}
        </Pressable>
        <Pressable
          style={styles.approveBtn}
          onPress={handleApprove}
          disabled={busy}
          accessibilityLabel={t("tasks.triage.approve")}
          testID={`task-proposal-approve-${key}`}
        >
          {action.kind === "approving" ? (
            <ActivityIndicator
              size="small"
              color="#ffffff"
              testID={`task-proposal-approving-${key}`}
            />
          ) : (
            <Check size={15} color="#ffffff" />
          )}
          <Text style={styles.actionText}>{t("tasks.triage.approve")}</Text>
        </Pressable>
        <Pressable
          style={styles.refuseBtn}
          onPress={handleRefuse}
          disabled={busy}
          accessibilityLabel={t("tasks.triage.refuse")}
          testID={`task-proposal-refuse-${key}`}
        >
          {action.kind === "refusing" ? (
            <ActivityIndicator
              size="small"
              color={styles.refuseText.color as string}
              testID={`task-proposal-refusing-${key}`}
            />
          ) : (
            <X size={15} color={styles.refuseText.color as string} />
          )}
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
  onBlur?: () => void;
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
  errorText: {
    color: theme.colors.statusDanger,
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

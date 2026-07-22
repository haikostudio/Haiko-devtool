import { type ReactNode, useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { Field, FormTextInput } from "@/components/ui/form-field";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { KanbanTask, TaskRunConfig, TaskSchedulePreference } from "@/data/tasks";
import {
  computeBillableCostChf,
  type EffectiveExecution,
  estimateTokenCostUsd,
  formatChf,
  formatUsd,
  resolveEffectiveExecution,
} from "@/components/tasks/task-cost";
import {
  deadlineTagFor,
  type ParsedPriority,
  parseTaskTags,
  PRIORITY_TAG_BY_LEVEL,
  serializeTaskTags,
} from "@/components/tasks/task-tags";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature } from "@/runtime/host-features";
import { navigateToAgent } from "@/utils/navigate-to-agent";

const DEFAULT_MODEL_OPTION_ID = "__default__";

// Footer/action buttons stay compact (32px) so the sheet reads as a form, not a
// wall of chunky CTAs — the field inputs keep the taller comfortable tap target.
const ACTION_BUTTON_SIZE = "sm" as const;
const ThemedTrash2 = withUnistyles(Trash2);
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const DELETE_ICON = <ThemedTrash2 size={16} uniProps={destructiveColorMapping} />;

// Which contextual actions a task exposes depends entirely on where it sits in
// its lifecycle. Analysis and execution only ever start from a validated task
// (the consent gate); a running/finished task offers a jump to its agent.
interface TaskActionAvailability {
  canRun: boolean;
  canEstimate: boolean;
  showViewAgent: boolean;
  primaryAgentId: string | null;
}

function resolveTaskActions(task: KanbanTask): TaskActionAvailability {
  const primaryAgentId = task.links.primaryAgentId ?? null;
  const scheduleState = task.schedule?.state ?? null;
  const isRunning =
    task.column === "in_progress" || scheduleState === "launching" || scheduleState === "running";
  const isDone = task.column === "done";
  const isActive = isRunning || isDone;
  return {
    // Launching bypasses the queue, so it only makes sense once validated/scheduled.
    canRun: !isActive && (task.column === "validated" || task.column === "scheduled"),
    // Estimation is a read-only preview — allowed anywhere the task isn't already moving.
    canEstimate: !isActive,
    showViewAgent: isActive && primaryAgentId !== null,
    primaryAgentId,
  };
}

// "Pause au choix" state for a task: whether it's currently held, and whether
// the hold toggle applies (only for in-pipeline tasks that aren't mid-launch).
// Kept at module scope so its branch count stays out of the form's complexity.
function resolveHoldState(task: KanbanTask): { isHeld: boolean; canHold: boolean } {
  const scheduleState = task.schedule?.state ?? null;
  const inPipeline = task.column === "validated" || task.column === "scheduled";
  const canHold =
    inPipeline &&
    scheduleState !== "launching" &&
    scheduleState !== "running" &&
    task.approval?.state !== "pending";
  return { isHeld: task.executionHold === true, canHold };
}

export interface TaskDetailSaveInput {
  taskId: string;
  title: string;
  description: string;
  tags: string[];
  runConfig: TaskRunConfig | null;
  schedulePreference: TaskSchedulePreference | null;
}

interface TaskDetailSheetProps {
  serverId: string | null;
  task: KanbanTask | null;
  visible: boolean;
  onClose: () => void;
  onSave: (input: TaskDetailSaveInput) => void;
  onDelete: (taskId: string) => void;
  onEstimate: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  onSetHold?: (taskId: string, hold: boolean) => void;
}

/**
 * Edit sheet for a kanban card: title/description/tags plus the automation
 * surface (execution config, estimate details, schedule errors, approval,
 * re-estimate and run-now actions). Fresh mount per task (`key` on the inner
 * form) so edits never leak between cards — see docs/forms.md lifecycle rule 1.
 */
export function TaskDetailSheet(props: TaskDetailSheetProps) {
  if (!props.task) {
    return null;
  }
  return <TaskDetailSheetForm key={props.task.id} {...props} task={props.task} />;
}

/**
 * Same editor rendered inline (no modal wrapper) so the desktop tasks board can
 * host it as the "Details" tab of the agent side panel. Fresh mount per task via
 * `key`, identical to the modal path.
 */
export function TaskDetailInlineForm(props: TaskDetailSheetProps) {
  if (!props.task) {
    return null;
  }
  return <TaskDetailSheetForm key={props.task.id} inline {...props} task={props.task} />;
}

interface ModelSelection {
  provider: string;
  model?: string;
}

interface ExecutionConfigState {
  modelSelection: ModelSelection | null;
  thinkingOptionId: string | null;
  mode: "direct" | "plan";
  schedulePreference: TaskSchedulePreference;
}

function buildRunConfig(state: ExecutionConfigState): TaskRunConfig | null {
  if (state.modelSelection) {
    return {
      provider: state.modelSelection.provider,
      ...(state.modelSelection.model ? { model: state.modelSelection.model } : {}),
      ...(state.thinkingOptionId ? { thinkingOptionId: state.thinkingOptionId } : {}),
      ...(state.mode === "plan" ? { mode: "plan" as const } : {}),
    };
  }
  if (state.mode === "plan") {
    // Plan mode without an explicit model still needs a runConfig carrier.
    return { provider: "claude", mode: "plan" as const };
  }
  return null;
}

function modelSelectionKey(value: ModelSelection | null): string {
  return value ? `${value.provider}/${value.model ?? "default"}` : DEFAULT_MODEL_OPTION_ID;
}

function thinkingOptionKey(value: string | null): string {
  return value ?? DEFAULT_MODEL_OPTION_ID;
}

function priorityValueKey(value: string | null): string {
  return value ?? "none";
}

function initialPriorityTag(priority: ParsedPriority | null): string | null {
  if (!priority) {
    return null;
  }
  return priority.level === "other" ? priority.raw : PRIORITY_TAG_BY_LEVEL[priority.level];
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

function TaskDetailSheetForm({
  serverId,
  task,
  visible,
  onClose,
  onSave,
  onDelete,
  onEstimate,
  onRunNow,
  onApprove,
  onSetHold,
  inline = false,
}: TaskDetailSheetProps & { task: KanbanTask; inline?: boolean }) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const controlSize = isCompact ? "md" : "sm";
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  // Priority and deadline are structured tags ("priorité-haute",
  // "échéance-15.07.26") — same parsing as the board card. The editor lifts
  // them into dedicated fields and only the thematic leftovers stay in the
  // free-text tags input; save reassembles the flat array.
  const parsedTags = useMemo(() => parseTaskTags(task.tags), [task.tags]);
  const [priorityTag, setPriorityTag] = useState<string | null>(() =>
    initialPriorityTag(parsedTags.priority),
  );
  const initialDeadline = parsedTags.deadline?.raw ?? "";
  const [deadlineText, setDeadlineText] = useState(initialDeadline);
  const [tagsText, setTagsText] = useState(parsedTags.tags.join(", "));
  const taskId = task.id;

  // COMPAT(tasksRunConfig): added in v0.1.110, drop the gate when floor >= v0.1.110.
  const supportsRunConfig = useHostFeature(serverId, "tasksRunConfig");

  const [executionConfig, setExecutionConfig] = useState<ExecutionConfigState>({
    modelSelection: task.runConfig
      ? { provider: task.runConfig.provider, model: task.runConfig.model }
      : null,
    thinkingOptionId: task.runConfig?.thinkingOptionId ?? null,
    mode: task.runConfig?.mode ?? "direct",
    schedulePreference: task.schedulePreference ?? "auto",
  });

  // Home-scope snapshot: the tasks screen only knows the projectId, and provider
  // availability does not depend on a specific checkout. Fetched once here so
  // both the execution section and the cost lines resolve the same concrete model.
  const snapshot = useProvidersSnapshot(serverId, { cwd: null, enabled: visible });
  const effective = useMemo(
    () =>
      resolveEffectiveExecution({
        entries: snapshot.entries,
        selection: executionConfig.modelSelection,
        thinkingOptionId: executionConfig.thinkingOptionId,
        mode: executionConfig.mode,
      }),
    [snapshot.entries, executionConfig],
  );

  const handleSave = useCallback(() => {
    if (!title.trim()) {
      return;
    }
    onSave({
      taskId,
      title: title.trim(),
      description: description.trim(),
      tags: serializeTaskTags({
        priorityTag,
        deadlineTag: deadlineTagFor(deadlineText),
        tags: tagsText
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      }),
      runConfig: buildRunConfig(executionConfig),
      schedulePreference:
        executionConfig.schedulePreference === "auto" ? null : executionConfig.schedulePreference,
    });
    onClose();
  }, [
    taskId,
    title,
    description,
    priorityTag,
    deadlineText,
    tagsText,
    executionConfig,
    onSave,
    onClose,
  ]);

  const handleDelete = useCallback(() => {
    onDelete(taskId);
    onClose();
  }, [taskId, onDelete, onClose]);

  const handleEstimate = useCallback(() => {
    onEstimate(taskId);
  }, [taskId, onEstimate]);

  const handleRunNow = useCallback(() => {
    onRunNow(taskId);
    onClose();
  }, [taskId, onRunNow, onClose]);

  const handleApprove = useCallback(() => {
    onApprove(taskId);
  }, [taskId, onApprove]);

  // "Pause au choix": the user can hold a pipeline task so it's analyzed but not
  // auto-launched, then review the plan and give the go (run-now) — or resume auto.
  const holdState = resolveHoldState(task);
  const isHeld = holdState.isHeld;
  // Hide the toggle when no handler is wired (keeps the feature self-consistent
  // even if a concurrent edit drops the screen-level wiring).
  const canHold = holdState.canHold && onSetHold !== undefined;
  const handleToggleHold = useCallback(() => {
    onSetHold?.(taskId, !isHeld);
  }, [onSetHold, taskId, isHeld]);

  const actions = useMemo(() => resolveTaskActions(task), [task]);
  const planAgentId = task.planReadyAt ? actions.primaryAgentId : null;
  const workspaceId = task.links.workspaceId ?? null;
  const handleViewPlan = useCallback(() => {
    if (!serverId || !planAgentId) {
      return;
    }
    navigateToAgent({ serverId, agentId: planAgentId, workspaceId });
    onClose();
  }, [serverId, planAgentId, workspaceId, onClose]);

  const viewAgentId = actions.showViewAgent ? actions.primaryAgentId : null;
  const handleViewAgent = useCallback(() => {
    if (!serverId || !viewAgentId) {
      return;
    }
    navigateToAgent({ serverId, agentId: viewAgentId, workspaceId });
    onClose();
  }, [serverId, viewAgentId, workspaceId, onClose]);

  const approvalPending = task.approval?.state === "pending";

  const header = useMemo((): SheetHeader => ({ title: t("tasks.detail.title") }), [t]);

  const footer = useMemo(
    () => <TaskFooter onDelete={handleDelete} onCancel={onClose} onSave={handleSave} />,
    [handleDelete, onClose, handleSave],
  );

  const body = (
    <>
      {approvalPending ? (
        <View style={styles.approvalBanner}>
          <View style={styles.approvalTextBlock}>
            <StatusBadge label={t("tasks.approval.pending")} variant="warning" />
            <Text style={styles.metaText}>{t("tasks.approval.explainer")}</Text>
          </View>
          <Button
            variant="default"
            size={ACTION_BUTTON_SIZE}
            onPress={handleApprove}
            testID="task-detail-approve"
          >
            {t("tasks.approval.approve")}
          </Button>
        </View>
      ) : null}

      <Field label={t("tasks.detail.titleField")}>
        <FormTextInput
          size={controlSize}
          initialValue={task.title}
          onChangeText={setTitle}
          testID="task-detail-title"
        />
      </Field>
      <Field label={t("tasks.detail.descriptionField")}>
        <FormTextInput
          size={controlSize}
          initialValue={task.description ?? ""}
          onChangeText={setDescription}
          style={styles.multilineInput}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
          testID="task-detail-description"
        />
      </Field>
      <PriorityField
        parsedPriority={parsedTags.priority}
        value={priorityTag}
        onChange={setPriorityTag}
        controlSize={controlSize}
      />
      <Field label={t("tasks.detail.deadlineField")}>
        <FormTextInput
          size={controlSize}
          initialValue={initialDeadline}
          onChangeText={setDeadlineText}
          placeholder={t("tasks.detail.deadlinePlaceholder")}
          testID="task-detail-deadline"
        />
      </Field>
      <Field label={t("tasks.detail.tagsField")}>
        <FormTextInput
          size={controlSize}
          initialValue={parsedTags.tags.join(", ")}
          onChangeText={setTagsText}
          placeholder={t("tasks.detail.tagsPlaceholder")}
          testID="task-detail-tags"
        />
      </Field>

      {supportsRunConfig ? (
        <ExecutionSection
          snapshot={snapshot}
          effective={effective}
          controlSize={controlSize}
          config={executionConfig}
          onChange={setExecutionConfig}
        />
      ) : null}

      <TaskMetaSection task={task} effective={effective} />

      <TaskActionsRow
        actions={actions}
        planAgentId={planAgentId}
        viewAgentId={viewAgentId}
        isHeld={isHeld}
        canHold={canHold}
        onRunNow={handleRunNow}
        onEstimate={handleEstimate}
        onToggleHold={handleToggleHold}
        onViewAgent={handleViewAgent}
        onViewPlan={handleViewPlan}
      />
    </>
  );

  return (
    <TaskDetailShell
      inline={inline}
      header={header}
      footer={footer}
      visible={visible}
      onClose={onClose}
    >
      {body}
    </TaskDetailShell>
  );
}

// Persistent bottom bar: delete stays a quiet ghost pinned left (destructive but
// not a giant red block), Cancel/Save sit right with Save as the only filled CTA.
function TaskFooter({
  onDelete,
  onCancel,
  onSave,
}: {
  onDelete: () => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.footerRow}>
      <Button
        variant="ghost"
        size={ACTION_BUTTON_SIZE}
        leftIcon={DELETE_ICON}
        textStyle={styles.deleteText}
        onPress={onDelete}
        testID="task-detail-delete"
      >
        {t("tasks.actions.delete")}
      </Button>
      <View style={styles.footerSpacer} />
      <Button variant="ghost" size={ACTION_BUTTON_SIZE} onPress={onCancel}>
        {t("common.actions.cancel")}
      </Button>
      <Button variant="default" size={ACTION_BUTTON_SIZE} onPress={onSave}>
        {t("tasks.actions.save")}
      </Button>
    </View>
  );
}

// Contextual actions, gated by lifecycle: run + estimate before launch, jump to
// the agent once running/done, view plan whenever a plan run has finished.
function TaskActionsRow({
  actions,
  planAgentId,
  viewAgentId,
  isHeld,
  canHold,
  onRunNow,
  onEstimate,
  onToggleHold,
  onViewAgent,
  onViewPlan,
}: {
  actions: TaskActionAvailability;
  planAgentId: string | null;
  viewAgentId: string | null;
  isHeld: boolean;
  canHold: boolean;
  onRunNow: () => void;
  onEstimate: () => void;
  onToggleHold: () => void;
  onViewAgent: () => void;
  onViewPlan: () => void;
}) {
  const { t } = useTranslation();
  if (!actions.canRun && !actions.canEstimate && !canHold && !planAgentId && !viewAgentId) {
    return null;
  }
  return (
    <View style={styles.actionsRow}>
      {actions.canRun ? (
        <Button
          variant="default"
          size={ACTION_BUTTON_SIZE}
          onPress={onRunNow}
          testID="task-detail-run-now"
        >
          {t("tasks.actions.runNow")}
        </Button>
      ) : null}
      {canHold ? (
        <Button
          variant="outline"
          size={ACTION_BUTTON_SIZE}
          onPress={onToggleHold}
          testID="task-detail-hold"
        >
          {isHeld ? t("tasks.actions.resumeAuto") : t("tasks.actions.hold")}
        </Button>
      ) : null}
      {actions.canEstimate ? (
        <Button variant="outline" size={ACTION_BUTTON_SIZE} onPress={onEstimate}>
          {t("tasks.actions.reanalyze")}
        </Button>
      ) : null}
      {viewAgentId ? (
        <Button
          variant="outline"
          size={ACTION_BUTTON_SIZE}
          onPress={onViewAgent}
          testID="task-detail-view-agent"
        >
          {t("tasks.detail.viewAgent")}
        </Button>
      ) : null}
      {planAgentId ? (
        <Button
          variant="outline"
          size={ACTION_BUTTON_SIZE}
          onPress={onViewPlan}
          testID="task-detail-view-plan"
        >
          {t("tasks.detail.viewPlan")}
        </Button>
      ) : null}
    </View>
  );
}

// Renders the editor either inline (desktop side panel) or wrapped in the modal
// sheet (compact). Split out of the form so the form's cyclomatic complexity
// stays under the lint budget.
function TaskDetailShell({
  inline,
  header,
  footer,
  visible,
  onClose,
  children,
}: {
  inline: boolean;
  header: SheetHeader;
  footer: ReactNode;
  visible: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (inline) {
    return (
      <View style={styles.inlineContainer}>
        <ScrollView
          style={styles.inlineScroll}
          contentContainerStyle={styles.inlineScrollContent}
          keyboardShouldPersistTaps="handled"
        >
          {children}
        </ScrollView>
        <View style={styles.inlineFooter}>{footer}</View>
      </View>
    );
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="task-detail-sheet"
      footer={footer}
    >
      {children}
    </AdaptiveModalSheet>
  );
}

function PriorityField({
  parsedPriority,
  value,
  onChange,
  controlSize,
}: {
  parsedPriority: ParsedPriority | null;
  value: string | null;
  onChange: (value: string | null) => void;
  controlSize: FieldControlSize;
}) {
  const { t } = useTranslation();

  const options = useMemo((): SelectFieldOption<string | null>[] => {
    const built: SelectFieldOption<string | null>[] = [
      { id: "none", value: null, label: t("tasks.detail.priorityNone") },
      { id: "high", value: PRIORITY_TAG_BY_LEVEL.high, label: t("tasks.detail.priorityHigh") },
      {
        id: "medium",
        value: PRIORITY_TAG_BY_LEVEL.medium,
        label: t("tasks.detail.priorityMedium"),
      },
      { id: "low", value: PRIORITY_TAG_BY_LEVEL.low, label: t("tasks.detail.priorityLow") },
    ];
    // Keep an unrecognized authored priority selectable instead of dropping it.
    if (parsedPriority?.level === "other") {
      built.push({
        id: parsedPriority.raw,
        value: parsedPriority.raw,
        label: parsedPriority.label,
      });
    }
    return built;
  }, [parsedPriority, t]);

  const display = useMemo(
    () => ({
      label:
        options.find((option) => option.value === value)?.label ?? t("tasks.detail.priorityNone"),
    }),
    [options, value, t],
  );

  return (
    <SelectField
      label={t("tasks.detail.priorityField")}
      value={value}
      selectedDisplay={display}
      options={options}
      onChange={onChange}
      placeholder={t("tasks.detail.priorityNone")}
      emptyText={t("tasks.detail.priorityNone")}
      size={controlSize}
      getValueKey={priorityValueKey}
      testID="task-detail-priority"
    />
  );
}

function ExecutionSection({
  snapshot,
  effective,
  controlSize,
  config,
  onChange,
}: {
  snapshot: ReturnType<typeof useProvidersSnapshot>;
  effective: EffectiveExecution;
  controlSize: FieldControlSize;
  config: ExecutionConfigState;
  onChange: (config: ExecutionConfigState) => void;
}) {
  const { t } = useTranslation();
  const { modelSelection, thinkingOptionId, mode, schedulePreference } = config;

  const modelOptions = useMemo((): SelectFieldOption<ModelSelection | null>[] => {
    const options: SelectFieldOption<ModelSelection | null>[] = [
      { id: DEFAULT_MODEL_OPTION_ID, value: null, label: t("tasks.detail.execution.modelDefault") },
    ];
    for (const entry of snapshot.entries ?? []) {
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
    // Keep an unknown persisted selection visible instead of silently dropping it.
    if (
      modelSelection &&
      !options.some(
        (option) => modelSelectionKey(option.value) === modelSelectionKey(modelSelection),
      )
    ) {
      options.push({
        id: modelSelectionKey(modelSelection),
        value: modelSelection,
        label: modelSelection.model ?? modelSelection.provider,
        description: modelSelection.provider,
      });
    }
    return options;
  }, [snapshot.entries, modelSelection, t]);

  const selectedModelDefinition = useMemo(() => {
    if (!modelSelection) {
      return null;
    }
    const entry = snapshot.entries?.find((item) => item.provider === modelSelection.provider);
    return entry?.models?.find((model) => model.id === modelSelection.model) ?? null;
  }, [snapshot.entries, modelSelection]);

  const thinkingOptions = useMemo((): SelectFieldOption<string | null>[] => {
    const options: SelectFieldOption<string | null>[] = [
      {
        id: DEFAULT_MODEL_OPTION_ID,
        value: null,
        label: t("tasks.detail.execution.thinkingDefault"),
      },
    ];
    for (const option of selectedModelDefinition?.thinkingOptions ?? []) {
      options.push({ id: option.id, value: option.id, label: option.label });
    }
    return options;
  }, [selectedModelDefinition, t]);

  const modeOptions = useMemo(
    (): SelectFieldOption<"direct" | "plan">[] => [
      {
        id: "direct",
        value: "direct",
        label: t("tasks.detail.execution.modeDirect"),
        description: t("tasks.detail.execution.modeDirectHint"),
      },
      {
        id: "plan",
        value: "plan",
        label: t("tasks.detail.execution.modePlan"),
        description: t("tasks.detail.execution.modePlanHint"),
      },
    ],
    [t],
  );

  const preferenceOptions = useMemo(
    (): SelectFieldOption<TaskSchedulePreference>[] => [
      {
        id: "auto",
        value: "auto",
        label: t("tasks.detail.execution.prefAuto"),
        description: t("tasks.detail.execution.prefAutoHint"),
      },
      { id: "asap", value: "asap", label: t("tasks.detail.execution.prefAsap") },
      { id: "off_peak", value: "off_peak", label: t("tasks.detail.execution.prefOffPeak") },
    ],
    [t],
  );

  const handleSelectModel = useCallback(
    (value: ModelSelection | null) => {
      // Thinking option ids are model-specific; reset on model change.
      onChange({ ...config, modelSelection: value, thinkingOptionId: null });
    },
    [config, onChange],
  );

  const handleSelectThinking = useCallback(
    (value: string | null) => {
      onChange({ ...config, thinkingOptionId: value });
    },
    [config, onChange],
  );

  const handleSelectMode = useCallback(
    (value: "direct" | "plan") => {
      onChange({ ...config, mode: value });
    },
    [config, onChange],
  );

  const handleSelectPreference = useCallback(
    (value: TaskSchedulePreference) => {
      onChange({ ...config, schedulePreference: value });
    },
    [config, onChange],
  );

  const modelDisplay = useMemo(
    () => ({
      label: modelSelection
        ? (selectedModelDefinition?.label ?? modelSelection.model ?? modelSelection.provider)
        : t("tasks.detail.execution.modelDefault"),
    }),
    [modelSelection, selectedModelDefinition, t],
  );

  const thinkingDisplay = useMemo(
    () => ({
      label:
        selectedModelDefinition?.thinkingOptions?.find((option) => option.id === thinkingOptionId)
          ?.label ?? t("tasks.detail.execution.thinkingDefault"),
    }),
    [selectedModelDefinition, thinkingOptionId, t],
  );

  const modeDisplay = useMemo(
    () => ({
      label:
        mode === "plan"
          ? t("tasks.detail.execution.modePlan")
          : t("tasks.detail.execution.modeDirect"),
    }),
    [mode, t],
  );

  const preferenceDisplay = useMemo(
    () => ({ label: t(preferenceLabelKey(schedulePreference)) }),
    [schedulePreference, t],
  );

  return (
    <View style={styles.executionSection}>
      <Text style={styles.sectionTitle}>{t("tasks.detail.execution.title")}</Text>
      <View style={styles.effectiveCard} testID="task-detail-effective">
        <Text style={styles.effectiveLabel}>{t("tasks.detail.execution.effectiveTitle")}</Text>
        <Text style={styles.effectiveLine}>
          {`${t("tasks.detail.execution.effectiveModel", { model: effective.modelLabel })}${
            effective.modelIsDefault ? ` ${t("tasks.detail.execution.defaultSuffix")}` : ""
          }`}
        </Text>
        {effective.thinkingLabel ? (
          <Text style={styles.effectiveLine}>
            {`${t("tasks.detail.execution.effectiveThinking", { level: effective.thinkingLabel })}${
              effective.thinkingIsDefault ? ` ${t("tasks.detail.execution.defaultSuffix")}` : ""
            }`}
          </Text>
        ) : null}
      </View>
      <SelectField
        label={t("tasks.detail.execution.model")}
        value={modelSelection}
        selectedDisplay={modelDisplay}
        options={modelOptions}
        onChange={handleSelectModel}
        placeholder={t("tasks.detail.execution.modelDefault")}
        emptyText={t("tasks.detail.execution.noModels")}
        loading={snapshot.isLoading}
        searchable
        size={controlSize}
        getValueKey={modelSelectionKey}
        testID="task-detail-model"
      />
      {thinkingOptions.length > 1 ? (
        <SelectField
          label={t("tasks.detail.execution.thinking")}
          value={thinkingOptionId}
          selectedDisplay={thinkingDisplay}
          options={thinkingOptions}
          onChange={handleSelectThinking}
          placeholder={t("tasks.detail.execution.thinkingDefault")}
          emptyText={t("tasks.detail.execution.thinkingDefault")}
          size={controlSize}
          getValueKey={thinkingOptionKey}
          testID="task-detail-thinking"
        />
      ) : null}
      <SelectField
        label={t("tasks.detail.execution.mode")}
        value={mode}
        selectedDisplay={modeDisplay}
        options={modeOptions}
        onChange={handleSelectMode}
        placeholder={t("tasks.detail.execution.modeDirect")}
        emptyText={t("tasks.detail.execution.modeDirect")}
        size={controlSize}
        testID="task-detail-mode"
      />
      <SelectField
        label={t("tasks.detail.execution.schedulePreference")}
        value={schedulePreference}
        selectedDisplay={preferenceDisplay}
        options={preferenceOptions}
        onChange={handleSelectPreference}
        placeholder={t("tasks.detail.execution.prefAuto")}
        emptyText={t("tasks.detail.execution.prefAuto")}
        size={controlSize}
        testID="task-detail-preference"
      />
    </View>
  );
}

function TaskMetaSection({ task, effective }: { task: KanbanTask; effective: EffectiveExecution }) {
  const { t } = useTranslation();
  const billableLabel =
    task.estimate?.estimatedMinutes !== undefined
      ? formatChf(computeBillableCostChf(task.estimate.estimatedMinutes))
      : null;
  const tokenCostLabel =
    task.estimate && effective.modelId
      ? formatUsd(estimateTokenCostUsd(effective.modelId, task.estimate.tokens))
      : null;
  return (
    <View style={styles.metaSection}>
      {task.estimate ? (
        <View style={styles.metaRow}>
          <StatusBadge
            label={t("tasks.card.quotaEstimate", {
              percent: Math.round(task.estimate.quotaPercent),
            })}
          />
          {task.estimate.estimatedMinutes !== undefined ? (
            <StatusBadge
              label={t("tasks.card.duration", { minutes: task.estimate.estimatedMinutes })}
            />
          ) : null}
          {billableLabel ? (
            <StatusBadge label={t("tasks.detail.cost.billable", { amount: billableLabel })} />
          ) : null}
          {tokenCostLabel ? (
            <StatusBadge label={t("tasks.detail.cost.tokens", { amount: tokenCostLabel })} />
          ) : null}
          <Text style={styles.metaText}>
            {t("tasks.detail.estimateDetail", {
              tokens: task.estimate.tokens.toLocaleString(),
              confidence: task.estimate.confidence,
            })}
          </Text>
        </View>
      ) : (
        <Text style={styles.metaText}>{t("tasks.detail.noEstimate")}</Text>
      )}
      {task.estimate?.summary ? <Text style={styles.metaText}>{task.estimate.summary}</Text> : null}
      {task.schedule?.lastError ? (
        <Text style={styles.errorText}>{task.schedule.lastError}</Text>
      ) : null}
      {task.links.prUrl ? (
        <ExternalLink href={task.links.prUrl} label={t("tasks.detail.openPr")} />
      ) : null}
      {task.links.branch ? (
        <Text style={styles.metaText}>
          {t("tasks.detail.branch", { branch: task.links.branch })}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  multilineInput: {
    minHeight: 96,
  },
  inlineContainer: {
    flex: 1,
  },
  inlineScroll: {
    flex: 1,
  },
  inlineScrollContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  inlineFooter: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    padding: theme.spacing[3],
  },
  approvalBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.palette.amber[700],
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[3],
  },
  approvalTextBlock: {
    flex: 1,
    gap: theme.spacing[1],
    alignItems: "flex-start",
  },
  executionSection: {
    marginTop: theme.spacing[2],
    gap: theme.spacing[3],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  effectiveCard: {
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  effectiveLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  effectiveLine: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  metaSection: {
    marginTop: theme.spacing[2],
    gap: theme.spacing[2],
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  actionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  footerRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  footerSpacer: {
    flex: 1,
  },
  deleteText: {
    color: theme.colors.destructive,
  },
}));

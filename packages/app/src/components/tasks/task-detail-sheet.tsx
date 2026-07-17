import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { Field, FormTextInput } from "@/components/ui/form-field";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { KanbanTask, TaskRunConfig, TaskSchedulePreference } from "@/data/tasks";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostFeature } from "@/runtime/host-features";
import { navigateToAgent } from "@/utils/navigate-to-agent";

const DEFAULT_MODEL_OPTION_ID = "__default__";

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
}: TaskDetailSheetProps & { task: KanbanTask }) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const controlSize = isCompact ? "md" : "sm";
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [tagsText, setTagsText] = useState(task.tags.join(", "));
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

  const handleSave = useCallback(() => {
    if (!title.trim()) {
      return;
    }
    onSave({
      taskId,
      title: title.trim(),
      description: description.trim(),
      tags: tagsText
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      runConfig: buildRunConfig(executionConfig),
      schedulePreference:
        executionConfig.schedulePreference === "auto" ? null : executionConfig.schedulePreference,
    });
    onClose();
  }, [taskId, title, description, tagsText, executionConfig, onSave, onClose]);

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

  const planAgentId = task.planReadyAt ? (task.links.primaryAgentId ?? null) : null;
  const planWorkspaceId = task.links.workspaceId ?? null;
  const handleViewPlan = useCallback(() => {
    if (!serverId || !planAgentId) {
      return;
    }
    navigateToAgent({ serverId, agentId: planAgentId, workspaceId: planWorkspaceId });
    onClose();
  }, [serverId, planAgentId, planWorkspaceId, onClose]);

  const approvalPending = task.approval?.state === "pending";

  const header = useMemo((): SheetHeader => ({ title: t("tasks.detail.title") }), [t]);

  const footer = useMemo(
    () => (
      <View style={styles.footerRow}>
        <Button style={styles.footerButton} variant="destructive" onPress={handleDelete}>
          {t("tasks.actions.delete")}
        </Button>
        <Button style={styles.footerButton} variant="secondary" onPress={onClose}>
          {t("common.actions.cancel")}
        </Button>
        <Button style={styles.footerButton} onPress={handleSave}>
          {t("tasks.actions.save")}
        </Button>
      </View>
    ),
    [handleDelete, onClose, handleSave, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="task-detail-sheet"
      footer={footer}
    >
      {approvalPending ? (
        <View style={styles.approvalBanner}>
          <View style={styles.approvalTextBlock}>
            <StatusBadge label={t("tasks.approval.pending")} variant="warning" />
            <Text style={styles.metaText}>{t("tasks.approval.explainer")}</Text>
          </View>
          <Button onPress={handleApprove} testID="task-detail-approve">
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
      <Field label={t("tasks.detail.tagsField")}>
        <FormTextInput
          size={controlSize}
          initialValue={task.tags.join(", ")}
          onChangeText={setTagsText}
          placeholder={t("tasks.detail.tagsPlaceholder")}
          testID="task-detail-tags"
        />
      </Field>

      {supportsRunConfig ? (
        <ExecutionSection
          serverId={serverId}
          visible={visible}
          controlSize={controlSize}
          config={executionConfig}
          onChange={setExecutionConfig}
        />
      ) : null}

      <TaskMetaSection task={task} />

      <View style={styles.actionsRow}>
        <Button variant="outline" onPress={handleEstimate}>
          {t("tasks.actions.reEstimate")}
        </Button>
        <Button variant="outline" onPress={handleRunNow}>
          {t("tasks.actions.runNow")}
        </Button>
        {planAgentId ? (
          <Button variant="outline" onPress={handleViewPlan} testID="task-detail-view-plan">
            {t("tasks.detail.viewPlan")}
          </Button>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function ExecutionSection({
  serverId,
  visible,
  controlSize,
  config,
  onChange,
}: {
  serverId: string | null;
  visible: boolean;
  controlSize: FieldControlSize;
  config: ExecutionConfigState;
  onChange: (config: ExecutionConfigState) => void;
}) {
  const { t } = useTranslation();
  const { modelSelection, thinkingOptionId, mode, schedulePreference } = config;

  // Home-scope snapshot: the tasks screen only knows the projectId, and provider
  // availability does not depend on a specific checkout.
  const snapshot = useProvidersSnapshot(serverId, { cwd: null, enabled: visible });

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

function TaskMetaSection({ task }: { task: KanbanTask }) {
  const { t } = useTranslation();
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
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
}));

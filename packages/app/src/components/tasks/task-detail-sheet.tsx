import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { KanbanTask } from "@/data/tasks";

interface TaskDetailSheetProps {
  task: KanbanTask | null;
  visible: boolean;
  onClose: () => void;
  onSave: (input: { taskId: string; title: string; description: string; tags: string[] }) => void;
  onDelete: (taskId: string) => void;
  onEstimate: (taskId: string) => void;
  onRunNow: (taskId: string) => void;
}

/**
 * Edit sheet for a kanban card: title/description/tags plus the automation
 * surface (estimate details, schedule errors, re-estimate and run-now actions).
 * Fresh mount per task (`key` on the inner form) so edits never leak between
 * cards — see docs/forms.md lifecycle rule 1.
 */
export function TaskDetailSheet(props: TaskDetailSheetProps) {
  if (!props.task) {
    return null;
  }
  return <TaskDetailSheetForm key={props.task.id} {...props} task={props.task} />;
}

function TaskDetailSheetForm({
  task,
  visible,
  onClose,
  onSave,
  onDelete,
  onEstimate,
  onRunNow,
}: TaskDetailSheetProps & { task: KanbanTask }) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const controlSize = isCompact ? "md" : "sm";
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? "");
  const [tagsText, setTagsText] = useState(task.tags.join(", "));
  const taskId = task.id;

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
    });
    onClose();
  }, [taskId, title, description, tagsText, onSave, onClose]);

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

      <View style={styles.metaSection}>
        {task.estimate ? (
          <View style={styles.metaRow}>
            <StatusBadge
              label={t("tasks.card.quotaEstimate", {
                percent: Math.round(task.estimate.quotaPercent),
              })}
            />
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
        {task.estimate?.summary ? (
          <Text style={styles.metaText}>{task.estimate.summary}</Text>
        ) : null}
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

      <View style={styles.actionsRow}>
        <Button variant="outline" onPress={handleEstimate}>
          {t("tasks.actions.reEstimate")}
        </Button>
        <Button variant="outline" onPress={handleRunNow}>
          {t("tasks.actions.runNow")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  multilineInput: {
    minHeight: 96,
  },
  metaSection: {
    marginTop: theme.spacing[2],
    gap: theme.spacing[2],
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
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

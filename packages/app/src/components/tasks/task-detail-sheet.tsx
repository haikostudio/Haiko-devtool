import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { StatusBadge } from "@/components/ui/status-badge";
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
 */
export function TaskDetailSheet({
  task,
  visible,
  onClose,
  onSave,
  onDelete,
  onEstimate,
  onRunNow,
}: TaskDetailSheetProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tagsText, setTagsText] = useState("");
  const taskId = task?.id ?? null;

  useEffect(() => {
    if (task && visible) {
      setTitle(task.title);
      setDescription(task.description ?? "");
      setTagsText(task.tags.join(", "));
    }
  }, [task, visible]);

  const handleSave = useCallback(() => {
    if (!taskId || !title.trim()) {
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
    if (taskId) {
      onDelete(taskId);
      onClose();
    }
  }, [taskId, onDelete, onClose]);

  const handleEstimate = useCallback(() => {
    if (taskId) {
      onEstimate(taskId);
    }
  }, [taskId, onEstimate]);

  const handleRunNow = useCallback(() => {
    if (taskId) {
      onRunNow(taskId);
      onClose();
    }
  }, [taskId, onRunNow, onClose]);

  const header = useMemo((): SheetHeader => ({ title: t("tasks.detail.title") }), [t]);

  const footer = useMemo(
    () => (
      <View style={styles.footerRow}>
        <Button variant="destructive" onPress={handleDelete}>
          {t("tasks.actions.delete")}
        </Button>
        <View style={styles.footerSpacer} />
        <Button variant="secondary" onPress={onClose}>
          {t("common.actions.cancel")}
        </Button>
        <Button onPress={handleSave}>{t("tasks.actions.save")}</Button>
      </View>
    ),
    [handleDelete, onClose, handleSave, t],
  );

  if (!task) {
    return null;
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="task-detail-sheet"
      footer={footer}
    >
      <View style={styles.content}>
        <Text style={styles.fieldLabel}>{t("tasks.detail.titleField")}</Text>
        <AdaptiveTextInput value={title} onChangeText={setTitle} testID="task-detail-title" />
        <Text style={styles.fieldLabel}>{t("tasks.detail.descriptionField")}</Text>
        <AdaptiveTextInput
          value={description}
          onChangeText={setDescription}
          multiline
          numberOfLines={4}
          testID="task-detail-description"
        />
        <Text style={styles.fieldLabel}>{t("tasks.detail.tagsField")}</Text>
        <AdaptiveTextInput
          value={tagsText}
          onChangeText={setTagsText}
          placeholder={t("tasks.detail.tagsPlaceholder")}
          testID="task-detail-tags"
        />

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
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  content: {
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  fieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[2],
  },
  metaSection: {
    marginTop: theme.spacing[3],
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
    marginTop: theme.spacing[3],
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  footerSpacer: {
    flex: 1,
  },
}));

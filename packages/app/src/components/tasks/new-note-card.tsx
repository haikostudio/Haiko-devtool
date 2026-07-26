import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import type { TaskImportanceLevel } from "@/components/tasks/kanban-columns";
import type { Theme } from "@/styles/theme";

// A note carries a short text, an importance (high/medium/low), and an optional
// deadline. The parent turns these into the same priority/deadline tags a normal
// task uses, so the note renders on the standard card and, once dragged to
// "backlog", flows through the usual cycle unchanged.
export interface NewNoteInput {
  text: string;
  importance: TaskImportanceLevel;
  deadline: string;
}

interface NewNoteCardProps {
  onSubmit: (input: NewNoteInput) => void;
  onCancel: () => void;
}

/**
 * Inline "new note" card rendered at the top of the Notes (draft) column. Unlike
 * the backlog composer, it deliberately captures nothing an agent needs: just a
 * line of text, an importance level, and a deadline. Submitting creates an inert
 * note — no estimate, no agent — that stays put until it's dragged into "À faire".
 */
export function NewNoteCard({ onSubmit, onCancel }: NewNoteCardProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [importance, setImportance] = useState<TaskImportanceLevel>("medium");
  const [deadline, setDeadline] = useState("");

  const importanceOptions = useMemo<SegmentedControlOption<TaskImportanceLevel>[]>(
    () => [
      {
        value: "high",
        label: t("tasks.detail.priorityHigh"),
        testID: "tasks-note-importance-high",
      },
      {
        value: "medium",
        label: t("tasks.detail.priorityMedium"),
        testID: "tasks-note-importance-medium",
      },
      { value: "low", label: t("tasks.detail.priorityLow"), testID: "tasks-note-importance-low" },
    ],
    [t],
  );

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onSubmit({ text: trimmed, importance, deadline: deadline.trim() });
  }, [text, importance, deadline, onSubmit, onCancel]);

  return (
    <View style={styles.card} testID="tasks-new-note-card">
      <FormTextInput
        size="sm"
        value={text}
        onChangeText={setText}
        placeholder={t("tasks.notes.placeholder")}
        multiline
        autoFocus
        testID="tasks-new-note-text"
      />
      <Text style={styles.fieldLabel}>{t("tasks.notes.importance")}</Text>
      <SegmentedControl
        options={importanceOptions}
        value={importance}
        onValueChange={setImportance}
        size="sm"
        fullWidth
        testID="tasks-new-note-importance"
      />
      <Text style={styles.fieldLabel}>{t("tasks.detail.deadlineField")}</Text>
      <FormTextInput
        size="sm"
        value={deadline}
        onChangeText={setDeadline}
        placeholder={t("tasks.detail.deadlinePlaceholder")}
        testID="tasks-new-note-deadline"
      />
      <View style={styles.actionsRow}>
        <Button size="sm" variant="ghost" onPress={onCancel} testID="tasks-new-note-cancel">
          {t("common.actions.cancel")}
        </Button>
        <Button size="sm" onPress={handleSubmit} testID="tasks-new-note-save">
          {t("tasks.notes.addNote")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  card: {
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  fieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  actionsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
}));

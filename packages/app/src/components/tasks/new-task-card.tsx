import { useCallback, useState } from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";

interface NewTaskCardProps {
  onSubmit: (input: { title: string; description: string }) => void;
  onCancel: () => void;
}

/**
 * Inline editable draft rendered at the top of a kanban column when the user
 * hits the column's "+": title + description, saved into that column.
 */
export function NewTaskCard({ onSubmit, onCancel }: NewTaskCardProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const handleSubmit = useCallback(() => {
    const trimmed = title.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onSubmit({ title: trimmed, description: description.trim() });
  }, [title, description, onSubmit, onCancel]);

  return (
    <View style={styles.card} testID="tasks-new-task-card">
      <FormTextInput
        size="sm"
        onChangeText={setTitle}
        placeholder={t("tasks.newTaskPlaceholder")}
        onSubmitEditing={handleSubmit}
        autoFocus
        testID="tasks-new-task-title"
      />
      <FormTextInput
        size="sm"
        onChangeText={setDescription}
        placeholder={t("tasks.newTaskDescriptionPlaceholder")}
        multiline
        numberOfLines={2}
        testID="tasks-new-task-description"
      />
      <View style={styles.actionsRow}>
        <Button size="sm" variant="ghost" onPress={onCancel}>
          {t("common.actions.cancel")}
        </Button>
        <Button size="sm" onPress={handleSubmit} testID="tasks-new-task-save">
          {t("tasks.actions.add")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  actionsRow: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));

import { memo, useCallback } from "react";
import { Pressable, Text } from "react-native";
import { Play } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { KanbanTask } from "@/data/tasks";
import type { Theme } from "@/styles/theme";

const accentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const ThemedPlay = withUnistyles(Play);

const ICON_SIZE = 14;

/**
 * The dedicated "Lancer maintenant" button shown directly on a "Planifié"
 * (scheduled) card, so the user can skip the queue without opening the ⋮ menu.
 * It reuses the exact same run-now path (`onRunTask` → `runNow` on the daemon),
 * which forces the "Planifié" → "En cours" transition immediately, bypassing the
 * off-peak window and the 5h-quota gate. Only rendered for scheduled cards — the
 * consent rule (a card must be validated first) is unchanged; this button just
 * surfaces the launch the user already asked for by dragging into "Planifié".
 * Always visible (not hover-gated) so it works the same on mobile and web.
 */
export const TaskRunNowButton = memo(function TaskRunNowButton({
  task,
  onRunTask,
}: {
  task: KanbanTask;
  onRunTask: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onRunTask(task.id);
  }, [onRunTask, task.id]);

  return (
    <Pressable
      onPress={handlePress}
      style={buttonStyle}
      accessibilityRole="button"
      accessibilityLabel={t("tasks.actions.runNow")}
      testID={`tasks-run-now-button-${task.id}`}
    >
      <ThemedPlay size={ICON_SIZE} uniProps={accentForegroundMapping} />
      <Text style={styles.label}>{t("tasks.actions.runNow")}</Text>
    </Pressable>
  );
});

function buttonStyle({ pressed }: { pressed: boolean }) {
  return [styles.button, pressed && styles.buttonPressed];
}

const styles = StyleSheet.create((theme) => ({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
  },
  buttonPressed: {
    opacity: 0.85,
  },
  label: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
  },
}));

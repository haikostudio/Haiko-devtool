import { memo, useCallback, useMemo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Check, Rocket } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { KanbanTask, TaskColumn } from "@/data/tasks";
import { isTaskDeployed } from "@/components/tasks/task-card-badge";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const accentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const ThemedRocket = withUnistyles(Rocket);
const ThemedCheck = withUnistyles(Check);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);

/** The cards a press would take online: queued, not archived, not live yet. */
export function countTasksAwaitingDeploy(tasks: readonly KanbanTask[]): number {
  return tasks.filter((task) => !task.archivedAt && !isTaskDeployed(task)).length;
}

/** True while the batch publication is running on at least one of these cards. */
export function isDeployAllRunning(tasks: readonly KanbanTask[]): boolean {
  return tasks.some((task) => task.deployment?.state === "running");
}

/**
 * "Tout déployer" — the one button that publishes.
 *
 * A finished card is parked in the last column ("À déployer") and waits there;
 * this pins the publication to a single, explicit press at the bottom of that
 * column instead of one build per card. The press hands the whole batch to the
 * daemon, which publishes it in one run and restarts the engine at the end.
 *
 * It only ever shows in the queue column, and only while something is actually
 * waiting: a column whose cards are all live shows nothing. While the run is on,
 * it turns into a non-clickable "Publication en cours…" so a second press can
 * never launch a duplicate build over the first one.
 */
export const DeployAllButton = memo(function DeployAllButton({
  column,
  tasks,
  onDeployAll,
  offPeakEnabled,
  onToggleOffPeak,
}: {
  column: TaskColumn;
  tasks: readonly KanbanTask[];
  onDeployAll?: (() => void) | undefined;
  /** State of the "publier en heures creuses" option, when the host exposes it. */
  offPeakEnabled?: boolean | undefined;
  onToggleOffPeak?: ((next: boolean) => void) | undefined;
}) {
  const { t } = useTranslation();
  const pending = useMemo(() => countTasksAwaitingDeploy(tasks), [tasks]);
  const running = useMemo(() => isDeployAllRunning(tasks), [tasks]);
  const barStyle = useCallback(
    ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.bar,
      running && styles.barDisabled,
      !running && (hovered || pressed) && styles.barHovered,
    ],
    [running],
  );
  const a11yState = useMemo(() => ({ disabled: running }), [running]);
  const handleToggleOffPeak = useCallback(() => {
    onToggleOffPeak?.(!offPeakEnabled);
  }, [onToggleOffPeak, offPeakEnabled]);
  const offPeakStyle = useCallback(
    ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.offPeak,
      (hovered || pressed) && styles.offPeakHovered,
    ],
    [],
  );
  if (column !== "deployed" || !onDeployAll || pending === 0) {
    return null;
  }
  const label = running
    ? t("tasks.board.deployAllRunning")
    : t("tasks.board.deployAll", { count: pending });
  return (
    <View style={styles.footer}>
      <Pressable
        onPress={onDeployAll}
        disabled={running}
        style={barStyle}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={a11yState}
        testID="tasks-deploy-all"
      >
        {running ? (
          <ThemedActivityIndicator size="small" uniProps={accentForegroundMapping} />
        ) : (
          <ThemedRocket size={ICON_SIZE.sm} uniProps={accentForegroundMapping} />
        )}
        <Text style={styles.text}>{label}</Text>
      </Pressable>
      {/* The opt-in twin of the button: same batch, same closing restart, fired
          on its own inside the quiet-hours window. Off unless asked for. */}
      {onToggleOffPeak ? (
        <Pressable
          onPress={handleToggleOffPeak}
          style={offPeakStyle}
          accessibilityRole="switch"
          accessibilityState={offPeakA11yState(offPeakEnabled === true)}
          accessibilityLabel={t("tasks.board.deployOffPeak")}
          testID="tasks-deploy-off-peak"
        >
          <View style={offPeakEnabled ? styles.checkboxOn : styles.checkbox}>
            {offPeakEnabled ? (
              <ThemedCheck size={ICON_SIZE.xs} uniProps={accentForegroundMapping} />
            ) : null}
          </View>
          <Text style={styles.offPeakText}>{t("tasks.board.deployOffPeak")}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

function offPeakA11yState(checked: boolean): { checked: boolean } {
  return { checked };
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    paddingTop: theme.spacing[2],
  },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    width: "100%",
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
  },
  barHovered: {
    opacity: 0.88,
  },
  barDisabled: {
    opacity: 0.6,
  },
  text: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  offPeak: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  offPeakHovered: {
    opacity: 0.8,
  },
  offPeakText: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  checkbox: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  checkboxOn: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
  },
}));

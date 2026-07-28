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
 * this pins the publication to a single, explicit press instead of one build per
 * card. The press hands the whole batch to the daemon, which publishes it in one
 * run and restarts the engine at the end.
 *
 * It sits at the HEAD of the queue column, outside the scrolling list. It used to
 * live under the cards, which reads fine on a wide screen and not at all on a
 * phone: the button was one full column of scrolling away, so the feature looked
 * missing. Pinned at the top it is the first thing the column says.
 *
 * It is ALWAYS shown in that column, even with nothing to publish — a control
 * that vanishes when idle is indistinguishable from a control that was never
 * built. Empty, it simply says so and cannot be pressed. While the run is on, it
 * turns into a non-clickable "Publication en cours…" so a second press can never
 * launch a duplicate build over the first one.
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
  const idle = pending === 0;
  const disabled = running || idle;
  const barStyle = useCallback(
    ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.bar,
      disabled && styles.barDisabled,
      idle && styles.barIdle,
      !disabled && (hovered || pressed) && styles.barHovered,
    ],
    [disabled, idle],
  );
  const a11yState = useMemo(() => ({ disabled }), [disabled]);
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
  if (column !== "deployed" || !onDeployAll) {
    return null;
  }
  const label = deployAllLabel(t, { running, idle, pending });
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onDeployAll}
        disabled={disabled}
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
        <Text style={styles.text} numberOfLines={1}>
          {label}
        </Text>
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

/** Publishing → waiting → nothing to do: three states, one line each. */
function deployAllLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  state: { running: boolean; idle: boolean; pending: number },
): string {
  if (state.running) {
    return t("tasks.board.deployAllRunning");
  }
  if (state.idle) {
    return t("tasks.board.deployAllEmpty");
  }
  return t("tasks.board.deployAll", { count: state.pending });
}

const styles = StyleSheet.create((theme) => ({
  header: {
    paddingBottom: theme.spacing[2],
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
  // Nothing waiting: the control stays visible but reads as inert rather than
  // like a live action that simply refuses to fire.
  barIdle: {
    opacity: 0.45,
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

import { memo, useCallback, useMemo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { ChevronDown, Rocket } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { KanbanTask, TaskColumn } from "@/data/tasks";
import { countTasksAwaitingDeploy, isDeployAllRunning } from "@/components/tasks/deploy-queue";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const accentForegroundMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const ThemedRocket = withUnistyles(Rocket);
const ThemedChevron = withUnistyles(ChevronDown);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);

/**
 * "Tout déployer" — the one button that publishes.
 *
 * A finished card is parked in the last column ("À déployer") and waits there;
 * this pins the publication to a single, explicit press instead of one build per
 * card. The press hands the whole batch to the daemon, which publishes it in one
 * run and restarts the engine at the end.
 *
 * It sits at the HEAD of the queue column, outside the scrolling list, aligned to
 * the same insets and gap as the search bar and the cards below it. It used to
 * live under the cards, which reads fine on a wide screen and not at all on a
 * phone: the button was one full column of scrolling away, so the feature looked
 * missing. Pinned at the top it is the first thing the column says.
 *
 * It is a split button: the wide left zone publishes, a narrow right zone opens a
 * menu. The "publier en heures creuses" opt-in lives inside that menu rather than
 * as a stray line of text under the button — an option, not a caption.
 *
 * It is ALWAYS shown in that column, even with nothing to publish — a control
 * that vanishes when idle is indistinguishable from a control that was never
 * built. Empty, the publish zone reads as inert and cannot be pressed (the menu
 * stays live, so off-peak can still be toggled). While the run is on, it turns
 * into a non-clickable "Publication en cours…" so a second press can never launch
 * a duplicate build over the first one.
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
  const actionStyle = useCallback(
    ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.action,
      disabled && styles.actionDisabled,
      idle && styles.actionIdle,
      !disabled && (hovered || pressed) && styles.actionHovered,
    ],
    [disabled, idle],
  );
  const chevronStyle = useCallback(
    ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.chevron,
      (hovered || pressed) && styles.chevronHovered,
    ],
    [],
  );
  const a11yState = useMemo(() => ({ disabled }), [disabled]);
  const handleToggleOffPeak = useCallback(() => {
    onToggleOffPeak?.(!offPeakEnabled);
  }, [onToggleOffPeak, offPeakEnabled]);
  if (column !== "deployed" || !onDeployAll) {
    return null;
  }
  const label = deployAllLabel(t, { running, idle, pending });
  return (
    <View style={styles.header}>
      <View style={styles.bar}>
        <Pressable
          onPress={onDeployAll}
          disabled={disabled}
          style={actionStyle}
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
        {/* The opt-in twin of the button — same batch, same closing restart, fired
            on its own inside the quiet-hours window — tucked behind the chevron so
            it stops crowding the button as a line of text. Off unless asked for. */}
        {onToggleOffPeak ? (
          <>
            <View style={styles.divider} />
            <DropdownMenu>
              <DropdownMenuTrigger
                style={chevronStyle}
                accessibilityRole="button"
                accessibilityLabel={t("tasks.board.deployMenu")}
                testID="tasks-deploy-menu"
              >
                <ThemedChevron size={ICON_SIZE.sm} uniProps={accentForegroundMapping} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" minWidth={260}>
                <DropdownMenuLabel>{t("tasks.board.deployMenu")}</DropdownMenuLabel>
                <DropdownMenuItem
                  selected={offPeakEnabled === true}
                  closeOnSelect={false}
                  onSelect={handleToggleOffPeak}
                  testID="tasks-deploy-off-peak"
                >
                  {t("tasks.board.deployOffPeak")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}
      </View>
    </View>
  );
});

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
  // Same horizontal inset and bottom gap as the search toolbar and the card list,
  // so the button lines up with everything else in the column.
  header: {
    // The board uses two renderers (scrollable and web). Explicit stretching
    // keeps this control aligned with the search row and cards in both instead
    // of letting an outer flex layout size it from its label.
    alignSelf: "stretch",
    width: "100%",
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  // The split button: one bordered, accent-filled bar holding a wide publish zone
  // and a narrow menu zone, kept visually joined by a soft inner divider.
  bar: {
    flexDirection: "row",
    alignItems: "stretch",
    width: "100%",
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.accent,
    overflow: "hidden",
  },
  // Left zone — the primary "Tout déployer" action. Grows to fill; icon and label
  // sit centred together so the rocket never clings to one edge.
  action: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  actionHovered: {
    opacity: 0.88,
  },
  actionDisabled: {
    opacity: 0.6,
  },
  // Nothing waiting: the publish zone stays visible but reads as inert rather than
  // like a live action that simply refuses to fire.
  actionIdle: {
    opacity: 0.45,
  },
  // Right zone — the menu trigger. A fixed, comfortable tap target on the edge.
  chevron: {
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[2],
  },
  chevronHovered: {
    opacity: 0.88,
  },
  divider: {
    width: 1,
    marginVertical: theme.spacing[1],
    backgroundColor: theme.colors.accentForeground,
    opacity: 0.25,
  },
  text: {
    color: theme.colors.accentForeground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
}));

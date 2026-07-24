import { useCallback } from "react";
import { Pressable, type PressableStateCallbackType, Text, View } from "react-native";
import { router } from "expo-router";
import {
  Activity,
  CalendarClock,
  History,
  LayoutDashboard,
  ScrollText,
  SquareKanban,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LIST_ROW_HEIGHT } from "@/components/ui/control-geometry";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useHostFeature } from "@/runtime/host-features";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Navigates to the new-workspace screen, seeding it with the active workspace's
 * project context when the host supports creating another workspace there. Shared
 * by the sidebar's primary actions and the Workspaces section header "+" button.
 */
export function useNewWorkspaceNavigation(onBeforeNavigate?: () => void) {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const activeWorkspace = useWorkspace(serverId, workspaceId);
  const supportsWorkspaceMultiplicity = useHostFeature(serverId, "workspaceMultiplicity");
  const canUseActiveWorkspaceContext = Boolean(
    activeWorkspace &&
    (supportsWorkspaceMultiplicity || canCreateWorktreeForProjectKind(activeWorkspace.projectKind)),
  );

  return useCallback(() => {
    onBeforeNavigate?.();
    router.push(
      serverId
        ? buildNewWorkspaceRoute(
            activeWorkspace && canUseActiveWorkspaceContext
              ? {
                  serverId,
                  sourceDirectory: activeWorkspace.projectRootPath,
                  projectId: activeWorkspace.projectId,
                }
              : { serverId },
          )
        : buildNewWorkspaceRoute(),
    );
  }, [activeWorkspace, canUseActiveWorkspaceContext, onBeforeNavigate, serverId]);
}

const ThemedHistory = withUnistyles(History);
const ThemedCalendarClock = withUnistyles(CalendarClock);
const ThemedLayoutDashboard = withUnistyles(LayoutDashboard);
const ThemedSquareKanban = withUnistyles(SquareKanban);
const ThemedScrollText = withUnistyles(ScrollText);
const ThemedActivity = withUnistyles(Activity);

const dashboardLeadingIcon = (
  <ThemedLayoutDashboard size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const sessionsLeadingIcon = (
  <ThemedHistory size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const schedulesLeadingIcon = (
  <ThemedCalendarClock size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const tasksLeadingIcon = (
  <ThemedSquareKanban size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const changelogLeadingIcon = (
  <ThemedScrollText size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const activityLeadingIcon = (
  <ThemedActivity size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);

interface SidebarPrimaryActionsProps {
  dashboardLabel: string;
  sessionsLabel: string;
  schedulesLabel: string;
  tasksLabel: string;
  changelogLabel: string;
  activityLabel: string;
  onViewDashboard: () => void;
  onViewSessions: () => void;
  onViewSchedules: () => void;
  onViewTasks: () => void;
  onViewChangelog: () => void;
  onViewActivity: () => void;
}

function ActionRow({
  label,
  leading,
  trailing,
  onPress,
  testID,
}: {
  label: string;
  leading: React.ReactNode;
  trailing?: React.ReactNode;
  onPress: () => void;
  testID?: string;
}) {
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [styles.row, pressed && styles.rowPressed],
    [],
  );
  return (
    <Pressable
      style={rowStyle}
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={styles.rowLeading}>{leading}</View>
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
      {trailing ? <View style={styles.rowTrailing}>{trailing}</View> : null}
    </Pressable>
  );
}

/**
 * The primary sidebar actions rendered as a flat, always-visible list. Used on
 * mobile where the collapsed dropdown trigger is an awkward touch target — the
 * buttons sit directly above the workspaces with a divider between the two.
 */
export function SidebarPrimaryActions({
  dashboardLabel,
  sessionsLabel,
  schedulesLabel,
  tasksLabel,
  changelogLabel,
  activityLabel,
  onViewDashboard,
  onViewSessions,
  onViewSchedules,
  onViewTasks,
  onViewChangelog,
  onViewActivity,
}: SidebarPrimaryActionsProps) {
  return (
    <View style={styles.container}>
      <ActionRow
        label={dashboardLabel}
        leading={dashboardLeadingIcon}
        onPress={onViewDashboard}
        testID="sidebar-dashboard"
      />
      <ActionRow
        label={tasksLabel}
        leading={tasksLeadingIcon}
        onPress={onViewTasks}
        testID="sidebar-tasks"
      />
      <ActionRow
        label={sessionsLabel}
        leading={sessionsLeadingIcon}
        onPress={onViewSessions}
        testID="sidebar-sessions"
      />
      <ActionRow
        label={schedulesLabel}
        leading={schedulesLeadingIcon}
        onPress={onViewSchedules}
        testID="sidebar-schedules"
      />
      <ActionRow
        label={activityLabel}
        leading={activityLeadingIcon}
        onPress={onViewActivity}
        testID="sidebar-activity"
      />
      <ActionRow
        label={changelogLabel}
        leading={changelogLeadingIcon}
        onPress={onViewChangelog}
        testID="sidebar-changelog"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: LIST_ROW_HEIGHT,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    marginHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowPressed: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowLeading: {
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  rowTrailing: {
    alignItems: "center",
    justifyContent: "center",
  },
}));

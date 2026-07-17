import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import {
  Activity,
  CalendarClock,
  ChevronDown,
  History,
  LayoutDashboard,
  Menu,
  Plus,
  ScrollText,
  SquareKanban,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Shortcut } from "@/components/ui/shortcut";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useHostFeature } from "@/runtime/host-features";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { buildNewWorkspaceRoute } from "@/utils/host-routes";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedMenu = withUnistyles(Menu);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedPlus = withUnistyles(Plus);
const ThemedHistory = withUnistyles(History);
const ThemedCalendarClock = withUnistyles(CalendarClock);
const ThemedLayoutDashboard = withUnistyles(LayoutDashboard);
const ThemedSquareKanban = withUnistyles(SquareKanban);
const ThemedScrollText = withUnistyles(ScrollText);
const ThemedActivity = withUnistyles(Activity);

const newWorkspaceLeadingIcon = (
  <ThemedPlus size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
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

interface SidebarPrimaryMenuProps {
  menuLabel: string;
  newWorkspaceLabel: string;
  dashboardLabel: string;
  sessionsLabel: string;
  schedulesLabel: string;
  tasksLabel: string;
  changelogLabel: string;
  activityLabel: string;
  newWorkspaceKeys: ShortcutKey[][] | null;
  onViewDashboard: () => void;
  onViewSessions: () => void;
  onViewSchedules: () => void;
  onViewTasks: () => void;
  onViewChangelog: () => void;
  onViewActivity: () => void;
  /** Runs before navigating to the new-workspace screen (e.g. closing the mobile sidebar). */
  onBeforeNavigate?: () => void;
  testID?: string;
}

/**
 * The single grouped button at the top of the sidebar. It collapses the previous
 * three header rows (New workspace / History / Schedules) into one menu trigger.
 */
export function SidebarPrimaryMenu({
  menuLabel,
  newWorkspaceLabel,
  dashboardLabel,
  sessionsLabel,
  schedulesLabel,
  tasksLabel,
  changelogLabel,
  activityLabel,
  newWorkspaceKeys,
  onViewDashboard,
  onViewSessions,
  onViewSchedules,
  onViewTasks,
  onViewChangelog,
  onViewActivity,
  onBeforeNavigate,
  testID,
}: SidebarPrimaryMenuProps) {
  const [open, setOpen] = useState(false);

  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const workspaceId = selection?.workspaceId ?? null;
  const activeWorkspace = useWorkspace(serverId, workspaceId);
  const supportsWorkspaceMultiplicity = useHostFeature(serverId, "workspaceMultiplicity");
  const canUseActiveWorkspaceContext = Boolean(
    activeWorkspace &&
    (supportsWorkspaceMultiplicity || canCreateWorktreeForProjectKind(activeWorkspace.projectKind)),
  );

  const handleNewWorkspace = useCallback(() => {
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

  const triggerStyle = useCallback(
    ({ hovered }: { hovered?: boolean }) => [styles.triggerBase, hovered && styles.triggerHovered],
    [],
  );

  const newWorkspaceTrailing = useMemo(
    () => (newWorkspaceKeys ? <Shortcut chord={newWorkspaceKeys} /> : null),
    [newWorkspaceKeys],
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        style={triggerStyle}
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={menuLabel}
      >
        {({ hovered }) => (
          <View style={styles.triggerRow}>
            <ThemedMenu
              size={ICON_SIZE.md}
              uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
            />
            <ThemedChevronDown
              size={ICON_SIZE.sm}
              uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
            />
          </View>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        offset={4}
        width={240}
        testID="sidebar-primary-menu-content"
      >
        <DropdownMenuItem
          testID="sidebar-global-new-workspace"
          leading={newWorkspaceLeadingIcon}
          trailing={newWorkspaceTrailing}
          onSelect={handleNewWorkspace}
        >
          {newWorkspaceLabel}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="sidebar-dashboard"
          leading={dashboardLeadingIcon}
          onSelect={onViewDashboard}
        >
          {dashboardLabel}
        </DropdownMenuItem>
        <DropdownMenuItem testID="sidebar-tasks" leading={tasksLeadingIcon} onSelect={onViewTasks}>
          {tasksLabel}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="sidebar-sessions"
          leading={sessionsLeadingIcon}
          onSelect={onViewSessions}
        >
          {sessionsLabel}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="sidebar-schedules"
          leading={schedulesLeadingIcon}
          onSelect={onViewSchedules}
        >
          {schedulesLabel}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="sidebar-activity"
          leading={activityLeadingIcon}
          onSelect={onViewActivity}
        >
          {activityLabel}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="sidebar-changelog"
          leading={changelogLeadingIcon}
          onSelect={onViewChangelog}
        >
          {changelogLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The trigger frame mirrors the compact sidebar header rows so it sits flush
  // against the workspace list below.
  triggerBase: {
    minHeight: 32,
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    marginHorizontal: theme.spacing[2],
    justifyContent: "center",
    userSelect: "none",
  },
  triggerHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  triggerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));

import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { EllipsisVertical, FolderPlus, Home, Plus, Server } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarHelpMenuItems } from "@/components/sidebar/sidebar-help-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHosts } from "@/runtime/host-runtime";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedEllipsis = withUnistyles(EllipsisVertical);
const ThemedFolderPlus = withUnistyles(FolderPlus);
const ThemedHome = withUnistyles(Home);
const ThemedServer = withUnistyles(Server);
const ThemedPlus = withUnistyles(Plus);

const addProjectLeadingIcon = (
  <ThemedFolderPlus size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const homeLeadingIcon = <ThemedHome size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />;
const hostLeadingIcon = <ThemedServer size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />;
const addHostLeadingIcon = (
  <ThemedPlus size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);

function HostMenuItem({
  host,
  onOpenHostSettings,
}: {
  host: HostProfile;
  onOpenHostSettings: (serverId: string) => void;
}) {
  const handleSelect = useCallback(
    () => onOpenHostSettings(host.serverId),
    [host.serverId, onOpenHostSettings],
  );
  return (
    <DropdownMenuItem
      testID={`sidebar-options-host-${host.serverId}`}
      leading={hostLeadingIcon}
      onSelect={handleSelect}
    >
      {host.label}
    </DropdownMenuItem>
  );
}

interface SidebarOptionsMenuLabels {
  options: string;
  addProject: string;
  home: string;
  hosts: string;
  addHost: string;
}

interface SidebarOptionsMenuProps {
  labels: SidebarOptionsMenuLabels;
  onOpenProject: () => void;
  onHome: () => void;
  onAddHost: () => void;
  onOpenHostSettings: (serverId: string) => void;
}

/**
 * The overflow (⋮) menu at the bottom-left of the sidebar. It collapses every
 * footer control except Settings — Add project, Home, the host picker, and the
 * Help section — into a single flat menu to keep the footer light.
 */
export function SidebarOptionsMenu({
  labels,
  onOpenProject,
  onHome,
  onAddHost,
  onOpenHostSettings,
}: SidebarOptionsMenuProps) {
  const [open, setOpen] = useState(false);
  const hosts = useHosts();

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={300} enabledOnDesktop={!open}>
        <TooltipTrigger asChild>
          <View>
            <DropdownMenuTrigger
              style={styles.trigger}
              testID="sidebar-options"
              accessibilityRole="button"
              accessibilityLabel={labels.options}
            >
              {({ hovered }) => (
                <ThemedEllipsis
                  size={ICON_SIZE.md}
                  uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
                />
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{labels.options}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        offset={8}
        width={260}
        testID="sidebar-options-menu"
      >
        <DropdownMenuItem
          testID="sidebar-add-project"
          leading={addProjectLeadingIcon}
          onSelect={onOpenProject}
        >
          {labels.addProject}
        </DropdownMenuItem>
        <DropdownMenuItem testID="sidebar-home" leading={homeLeadingIcon} onSelect={onHome}>
          {labels.home}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{labels.hosts}</DropdownMenuLabel>
        {hosts.map((host) => (
          <HostMenuItem key={host.serverId} host={host} onOpenHostSettings={onOpenHostSettings} />
        ))}
        <DropdownMenuItem
          testID="sidebar-options-add-host"
          leading={addHostLeadingIcon}
          onSelect={onAddHost}
        >
          {labels.addHost}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <SidebarHelpMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));

import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { FolderTree } from "lucide-react-native";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { TaskBottomDock } from "@/components/tasks/task-bottom-dock";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedTree = withUnistyles(FolderTree);

export interface TaskExplorerDockProps {
  serverId: string | null;
  workspaceId: string | null;
  /** Absolute path of the project's root checkout — the tree's starting point. */
  projectRootPath: string | null;
}

/**
 * The project's file tree, docked at the bottom of the board like the conductor
 * chat and the Details drawer — draggable, resizable, collapsible.
 *
 * It stays mounted while the board is open so toggling it is instant: the tree
 * keeps its expanded folders and scroll position between openings instead of
 * reloading the directory listing every time.
 */
export function TaskExplorerDock({
  serverId,
  workspaceId,
  projectRootPath,
}: TaskExplorerDockProps) {
  const { t } = useTranslation();
  const open = useTasksBoardUiStore((state) => state.explorerOpen);
  const setOpen = useTasksBoardUiStore((state) => state.setExplorerOpen);
  const height = useTasksBoardUiStore((state) => state.explorerHeight);
  const setHeight = useTasksBoardUiStore((state) => state.setExplorerHeight);
  const offsetX = useTasksBoardUiStore((state) => state.explorerOffsetX);
  const setOffsetX = useTasksBoardUiStore((state) => state.setExplorerOffsetX);
  const collapsed = useTasksBoardUiStore((state) => state.explorerCollapsed);
  const setCollapsed = useTasksBoardUiStore((state) => state.setExplorerCollapsed);

  const handleClose = useCallback(() => setOpen(false), [setOpen]);
  // Memoized: a fresh header object would re-render the whole dock on every tick.
  const header = useMemo(
    () => ({
      title: t("tasks.explorer.title"),
      leading: <ThemedTree size={ICON_SIZE.sm} uniProps={mutedColorMapping} />,
    }),
    [t],
  );
  const handleToggleCollapse = useCallback(
    () => setCollapsed(!collapsed),
    [collapsed, setCollapsed],
  );

  if (!open) {
    return null;
  }

  return (
    <TaskBottomDock
      header={header}
      visible
      onClose={handleClose}
      height={height}
      offsetX={offsetX}
      collapsed={collapsed}
      onResize={setHeight}
      onMove={setOffsetX}
      onToggleCollapse={handleToggleCollapse}
      testID="tasks-explorer-dock"
    >
      <View style={styles.body}>
        {serverId && projectRootPath ? (
          <FileExplorerPane
            serverId={serverId}
            workspaceId={workspaceId}
            workspaceRoot={projectRootPath}
          />
        ) : (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>{t("tasks.explorer.noProject")}</Text>
          </View>
        )}
      </View>
    </TaskBottomDock>
  );
}

const styles = StyleSheet.create((theme) => ({
  // The tree owns its own scroll, so the dock body is a bounded flex column.
  body: {
    flex: 1,
    minHeight: 0,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

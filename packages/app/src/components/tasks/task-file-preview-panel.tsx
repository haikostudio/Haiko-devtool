import { useCallback, useEffect, useMemo, useRef } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { FilePane } from "@/file-pane/pane";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { getFileNameFromPath } from "@/attachments/utils";
import { TaskSlideOverPanel } from "./task-slide-over-panel";

export interface TaskFilePreviewPanelProps {
  serverId: string | null;
  /** Absolute path of the project's root checkout — the read is relative to it. */
  projectRootPath: string | null;
}

/**
 * Reads the board's preview selection and keeps the last non-null path alive for
 * the length of the closing animation, so the panel slides out showing the file
 * it was showing instead of blanking the instant it is dismissed.
 */
function usePreviewSelection() {
  const filePath = useTasksBoardUiStore((state) => state.previewFilePath);
  const setFilePath = useTasksBoardUiStore((state) => state.setPreviewFilePath);
  const lastPathRef = useRef<string | null>(filePath);
  if (filePath) {
    lastPathRef.current = filePath;
  }
  const close = useCallback(() => setFilePath(null), [setFilePath]);
  return { filePath, displayedPath: lastPathRef.current, close };
}

/**
 * The board's file preview: tapping a file in the explorer tree opens its
 * contents here (syntax highlighting, markdown preview and images all come from
 * the shared `FilePane`, same as the workspace's file tabs).
 *
 * Chrome — slide-in overlay on desktop, full-height sheet on compact — comes
 * from the shared `TaskSlideOverPanel`, which the attachments library reuses.
 */
export function TaskFilePreviewPanel({ serverId, projectRootPath }: TaskFilePreviewPanelProps) {
  const { t } = useTranslation();
  useClearPreviewOnProjectChange(projectRootPath);
  const { filePath, displayedPath, close } = usePreviewSelection();
  const header = useMemo(
    () => ({ title: getFileNameFromPath(displayedPath) ?? displayedPath ?? "" }),
    [displayedPath],
  );
  // Drag the left edge to trade board width for reading width; the size sticks
  // across reloads like every other panel on this board.
  const requestedWidth = useTasksBoardUiStore((state) => state.previewWidth);
  const onRequestWidth = useTasksBoardUiStore((state) => state.setPreviewWidth);
  const resize = useMemo(
    () => ({ requestedWidth, onRequestWidth }),
    [onRequestWidth, requestedWidth],
  );

  return (
    <TaskSlideOverPanel
      open={Boolean(filePath)}
      onClose={close}
      header={header}
      resize={resize}
      testID="tasks-file-preview-panel"
      sheetTestID="tasks-file-preview-sheet"
      closeTestID="tasks-file-preview-close"
      closeAccessibilityLabel={t("tasks.filePreview.close")}
    >
      <PreviewBody serverId={serverId} projectRootPath={projectRootPath} filePath={displayedPath} />
    </TaskSlideOverPanel>
  );
}

/**
 * Switching projects drops the preview: the open path belongs to the previous
 * checkout, and reading it against the new root would either fail or, worse,
 * silently show a same-named file from somewhere else.
 */
function useClearPreviewOnProjectChange(projectRootPath: string | null) {
  const setFilePath = useTasksBoardUiStore((state) => state.setPreviewFilePath);
  const previousRootRef = useRef(projectRootPath);
  useEffect(() => {
    if (previousRootRef.current !== projectRootPath) {
      previousRootRef.current = projectRootPath;
      setFilePath(null);
    }
  }, [projectRootPath, setFilePath]);
}

/**
 * The file itself. Keyed by path so switching files remounts the reader with a
 * clean state while the panel stays open — no close/re-open flicker.
 */
function PreviewBody({
  serverId,
  projectRootPath,
  filePath,
}: {
  serverId: string | null;
  projectRootPath: string | null;
  filePath: string | null;
}) {
  const { t } = useTranslation();
  const location = useMemo(() => (filePath ? { path: filePath } : null), [filePath]);

  if (!serverId || !projectRootPath || !location) {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>{t("tasks.explorer.noProject")}</Text>
      </View>
    );
  }
  return (
    <FilePane
      key={location.path}
      serverId={serverId}
      workspaceRoot={projectRootPath}
      location={location}
      navigationRevision={0}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
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

import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { ChevronLeft, ChevronRight, Folder, Plus, Trash2 } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { MenuHeader } from "@/components/headers/menu-header";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { KanbanBoard } from "@/components/tasks/kanban-board";
import { TaskDetailSheet } from "@/components/tasks/task-detail-sheet";
import { Button } from "@/components/ui/button";
import { useTaskBoard, type KanbanTask, type TaskColumn, type TaskFolder } from "@/data/tasks";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { buildTasksRoute } from "@/utils/host-routes";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedFolder = withUnistyles(Folder);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedTrash = withUnistyles(Trash2);

interface ProjectEntry {
  serverId: string;
  hostLabel: string;
  projectId: string;
  displayName: string;
  rootPath: string;
}

function rowItemStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.rowItem, (hovered || pressed) && styles.rowItemHovered];
}

function useProjectEntries(): ProjectEntry[] {
  const hosts = useHosts();
  const sessions = useSessionStore(useShallow((state) => state.sessions));
  return useMemo(() => {
    const entries: ProjectEntry[] = [];
    const seen = new Set<string>();
    for (const host of hosts) {
      const session = sessions[host.serverId];
      if (!session) {
        continue;
      }
      for (const workspace of session.workspaces.values()) {
        const key = `${host.serverId}:${workspace.projectId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        entries.push({
          serverId: host.serverId,
          hostLabel: host.label,
          projectId: workspace.projectId,
          displayName: workspace.projectCustomName ?? workspace.projectDisplayName,
          rootPath: workspace.projectRootPath,
        });
      }
      for (const project of session.emptyProjects.values()) {
        const key = `${host.serverId}:${project.projectId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        entries.push({
          serverId: host.serverId,
          hostLabel: host.label,
          projectId: project.projectId,
          displayName: project.projectCustomName ?? project.projectDisplayName,
          rootPath: project.projectRootPath,
        });
      }
    }
    return entries.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [hosts, sessions]);
}

export function TasksScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ host?: string; project?: string; folder?: string }>();
  const serverId = typeof params.host === "string" && params.host ? params.host : null;
  const projectId = typeof params.project === "string" && params.project ? params.project : null;
  const folderId = typeof params.folder === "string" && params.folder ? params.folder : null;

  const projects = useProjectEntries();
  const supportsTasksBoard = useHostFeature(serverId, "tasksBoard");
  const boardHandle = useTaskBoard(serverId, projectId);

  const selectedProject = useMemo(
    () =>
      projects.find((entry) => entry.serverId === serverId && entry.projectId === projectId) ??
      null,
    [projects, serverId, projectId],
  );
  const selectedFolder = useMemo(
    () => boardHandle.board?.folders.find((folder) => folder.id === folderId) ?? null,
    [boardHandle.board, folderId],
  );

  let title = t("tasks.title");
  if (selectedFolder) {
    title = `${t("tasks.title")} · ${selectedFolder.name}`;
  } else if (selectedProject) {
    title = `${t("tasks.title")} · ${selectedProject.displayName}`;
  }

  let body: React.ReactNode;
  if (!serverId || !projectId) {
    body = <ProjectPicker projects={projects} />;
  } else if (!supportsTasksBoard) {
    body = (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>{t("tasks.updateHost")}</Text>
      </View>
    );
  } else if (boardHandle.error) {
    body = (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>{boardHandle.error}</Text>
      </View>
    );
  } else if (!folderId) {
    body = <FolderList serverId={serverId} projectId={projectId} boardHandle={boardHandle} />;
  } else {
    body = (
      <BoardView
        serverId={serverId}
        projectId={projectId}
        folderId={folderId}
        boardHandle={boardHandle}
      />
    );
  }

  return (
    <View style={styles.container}>
      <MenuHeader title={title} />
      {body}
    </View>
  );
}

function clearTasksSelection() {
  router.setParams({ host: undefined, project: undefined, folder: undefined });
}

function ProjectPicker({ projects }: { projects: ProjectEntry[] }) {
  const { t } = useTranslation();
  return (
    <ScrollView contentContainerStyle={styles.listContent}>
      <Text style={styles.sectionLabel}>{t("tasks.pickProject")}</Text>
      {projects.length === 0 ? <Text style={styles.emptyText}>{t("tasks.noProjects")}</Text> : null}
      {projects.map((entry) => (
        <ProjectRow key={`${entry.serverId}:${entry.projectId}`} entry={entry} />
      ))}
    </ScrollView>
  );
}

const ProjectRow = memo(function ProjectRow({ entry }: { entry: ProjectEntry }) {
  const handlePress = useCallback(() => {
    router.setParams({ host: entry.serverId, project: entry.projectId, folder: undefined });
  }, [entry.serverId, entry.projectId]);
  return (
    <Pressable
      style={rowItemStyle}
      onPress={handlePress}
      testID={`tasks-project-${entry.projectId}`}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{entry.displayName}</Text>
        <Text style={styles.rowSubtitle}>{entry.hostLabel}</Text>
      </View>
      <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
    </Pressable>
  );
});

type BoardHandle = ReturnType<typeof useTaskBoard>;

function FolderList({
  serverId,
  projectId,
  boardHandle,
}: {
  serverId: string;
  projectId: string;
  boardHandle: BoardHandle;
}) {
  const { t } = useTranslation();
  const [newFolderName, setNewFolderName] = useState("");
  const folders = useMemo(
    () => [...(boardHandle.board?.folders ?? [])].sort((left, right) => left.order - right.order),
    [boardHandle.board],
  );
  const taskCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of boardHandle.board?.tasks ?? []) {
      counts.set(task.folderId, (counts.get(task.folderId) ?? 0) + 1);
    }
    return counts;
  }, [boardHandle.board]);

  const handleCreateFolder = useCallback(() => {
    const name = newFolderName.trim();
    if (!name) {
      return;
    }
    setNewFolderName("");
    void boardHandle.createFolder(name);
  }, [newFolderName, boardHandle]);

  return (
    <ScrollView contentContainerStyle={styles.listContent}>
      <Pressable
        style={styles.backRow}
        onPress={clearTasksSelection}
        testID="tasks-back-to-projects"
      >
        <ThemedChevronLeft size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        <Text style={styles.rowSubtitle}>{t("tasks.allProjects")}</Text>
      </Pressable>
      <Text style={styles.sectionLabel}>{t("tasks.folders")}</Text>
      {folders.map((folder) => (
        <FolderRow
          key={folder.id}
          folder={folder}
          serverId={serverId}
          projectId={projectId}
          taskCount={taskCounts.get(folder.id) ?? 0}
          onDeleteFolder={boardHandle.deleteFolder}
        />
      ))}
      {folders.length === 0 && !boardHandle.isLoading ? (
        <Text style={styles.emptyText}>{t("tasks.noFolders")}</Text>
      ) : null}
      <View style={styles.newFolderRow}>
        <View style={styles.newFolderInput}>
          <AdaptiveTextInput
            value={newFolderName}
            onChangeText={setNewFolderName}
            placeholder={t("tasks.newFolderPlaceholder")}
            onSubmitEditing={handleCreateFolder}
            testID="tasks-new-folder-input"
          />
        </View>
        <Button leftIcon={Plus} onPress={handleCreateFolder} testID="tasks-new-folder-submit">
          {t("tasks.actions.addFolder")}
        </Button>
      </View>
    </ScrollView>
  );
}

const FolderRow = memo(function FolderRow({
  folder,
  serverId,
  projectId,
  taskCount,
  onDeleteFolder,
}: {
  folder: TaskFolder;
  serverId: string;
  projectId: string;
  taskCount: number;
  onDeleteFolder: (folderId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => {
    router.push(buildTasksRoute({ host: serverId, project: projectId, folder: folder.id }));
  }, [serverId, projectId, folder.id]);
  const handleDelete = useCallback(() => {
    void onDeleteFolder(folder.id);
  }, [onDeleteFolder, folder.id]);

  return (
    <Pressable style={rowItemStyle} onPress={handleOpen} testID={`tasks-folder-${folder.id}`}>
      <ThemedFolder size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{folder.name}</Text>
        <Text style={styles.rowSubtitle}>{t("tasks.taskCount", { count: taskCount })}</Text>
      </View>
      <Pressable
        onPress={handleDelete}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("tasks.actions.delete")}
        testID={`tasks-folder-delete-${folder.id}`}
      >
        <ThemedTrash size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      </Pressable>
    </Pressable>
  );
});

function BoardView({
  serverId,
  projectId,
  folderId,
  boardHandle,
}: {
  serverId: string;
  projectId: string;
  folderId: string;
  boardHandle: BoardHandle;
}) {
  const { t } = useTranslation();
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [newTaskColumn, setNewTaskColumn] = useState<TaskColumn | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState("");

  const detailTask = useMemo(
    () =>
      detailTaskId
        ? (boardHandle.board?.tasks.find((task) => task.id === detailTaskId) ?? null)
        : null,
    [detailTaskId, boardHandle.board],
  );

  const handleMoveTask = useCallback(
    (input: { taskId: string; column: TaskColumn; index: number }) => {
      void boardHandle.moveTask(input);
    },
    [boardHandle],
  );

  const handlePressTask = useCallback((task: KanbanTask) => {
    setDetailTaskId(task.id);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setDetailTaskId(null);
  }, []);

  const handleBackToFolders = useCallback(() => {
    router.push(buildTasksRoute({ host: serverId, project: projectId }));
  }, [serverId, projectId]);

  const handleCancelNewTask = useCallback(() => {
    setNewTaskColumn(null);
  }, []);

  const handleCreateTask = useCallback(() => {
    const taskTitle = newTaskTitle.trim();
    if (!taskTitle || !newTaskColumn) {
      return;
    }
    const targetColumn = newTaskColumn;
    setNewTaskTitle("");
    setNewTaskColumn(null);
    void boardHandle.createTask({ folderId, title: taskTitle, column: targetColumn });
  }, [newTaskTitle, newTaskColumn, folderId, boardHandle]);

  const handleSaveTask = useCallback(
    ({
      taskId,
      title,
      description,
      tags,
    }: {
      taskId: string;
      title: string;
      description: string;
      tags: string[];
    }) => {
      void boardHandle.updateTask({ taskId, title, description: description || null, tags });
    },
    [boardHandle],
  );

  const handleDeleteTask = useCallback(
    (taskId: string) => {
      void boardHandle.deleteTask(taskId);
    },
    [boardHandle],
  );

  const handleEstimateTask = useCallback(
    (taskId: string) => {
      void boardHandle.estimateTask(taskId);
    },
    [boardHandle],
  );

  const handleRunTaskNow = useCallback(
    (taskId: string) => {
      void boardHandle.runTaskNow(taskId);
    },
    [boardHandle],
  );

  return (
    <View style={styles.boardContainer}>
      <Pressable
        style={styles.backRow}
        onPress={handleBackToFolders}
        testID="tasks-back-to-folders"
      >
        <ThemedChevronLeft size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        <Text style={styles.rowSubtitle}>{t("tasks.folders")}</Text>
      </Pressable>
      {newTaskColumn ? (
        <View style={styles.newTaskRow}>
          <View style={styles.newFolderInput}>
            <AdaptiveTextInput
              value={newTaskTitle}
              onChangeText={setNewTaskTitle}
              placeholder={t("tasks.newTaskPlaceholder")}
              onSubmitEditing={handleCreateTask}
              autoFocus
              testID="tasks-new-task-input"
            />
          </View>
          <Button onPress={handleCreateTask} testID="tasks-new-task-submit">
            {t("tasks.actions.add")}
          </Button>
          <Button variant="ghost" onPress={handleCancelNewTask}>
            {t("common.actions.cancel")}
          </Button>
        </View>
      ) : null}
      <KanbanBoard
        board={boardHandle.board}
        folderId={folderId}
        onMoveTask={handleMoveTask}
        onPressTask={handlePressTask}
        onAddTask={setNewTaskColumn}
      />
      <TaskDetailSheet
        task={detailTask}
        visible={detailTask !== null}
        onClose={handleCloseDetail}
        onSave={handleSaveTask}
        onDelete={handleDeleteTask}
        onEstimate={handleEstimateTask}
        onRunNow={handleRunTaskNow}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  boardContainer: {
    flex: 1,
    gap: theme.spacing[2],
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
  },
  listContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[2],
    maxWidth: 720,
    width: "100%",
    alignSelf: "center",
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: theme.spacing[1],
  },
  rowItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  rowItemHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  rowSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    paddingVertical: theme.spacing[4],
  },
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    alignSelf: "flex-start",
  },
  newFolderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
  },
  newTaskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  newFolderInput: {
    flex: 1,
  },
}));

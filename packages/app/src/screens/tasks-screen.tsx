import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import {
  ArrowDownAZ,
  ChevronLeft,
  ChevronRight,
  Clock,
  Folder,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { MenuHeader } from "@/components/headers/menu-header";
import { FolderCreateModal } from "@/components/tasks/folder-create-modal";
import { FormTextInput } from "@/components/ui/form-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { KanbanBoard } from "@/components/tasks/kanban-board";
import { KANBAN_COLUMNS, KANBAN_COLUMN_MAX_WIDTH } from "@/components/tasks/kanban-columns";
import { TaskGantt } from "@/components/tasks/task-gantt";
import { NewTaskCard } from "@/components/tasks/new-task-card";
import { TaskDetailSheet, type TaskDetailSaveInput } from "@/components/tasks/task-detail-sheet";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useTaskBoard, type KanbanTask, type TaskColumn, type TaskFolder } from "@/data/tasks";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { deriveProjectIconColor } from "@/utils/project-icon-color";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const ThemedFolder = withUnistyles(Folder);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedTrash = withUnistyles(Trash2);
const ThemedKebab = withUnistyles(MoreVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedClock = withUnistyles(Clock);
const ThemedSortAz = withUnistyles(ArrowDownAZ);

const MENU_ICON_SIZE = 16;
const editLeading = <ThemedPencil size={MENU_ICON_SIZE} uniProps={mutedColorMapping} />;
const deleteLeading = <ThemedTrash size={MENU_ICON_SIZE} uniProps={destructiveColorMapping} />;

// Reusable three-dots menu for a folder card: opens on the right of the card
// and offers rename/edit + delete. The card's own onPress opens the folder on
// the board; this trigger is a nested Pressable, so the responder system routes
// the tap here and it never selects the folder underneath.
const FolderKebabMenu = memo(function FolderKebabMenu({
  folderId,
  onEdit,
  onDelete,
}: {
  folderId: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("tasks.actions.folderActions")}
        testID={`tasks-folder-menu-${folderId}`}
      >
        <ThemedKebab size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={180}>
        <DropdownMenuItem
          leading={editLeading}
          onSelect={onEdit}
          testID={`tasks-folder-menu-edit-${folderId}`}
        >
          {t("tasks.actions.edit")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={deleteLeading}
          destructive
          onSelect={onDelete}
          testID={`tasks-folder-menu-delete-${folderId}`}
        >
          {t("tasks.actions.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

type ProjectSortMode = "recent" | "name";

interface ProjectEntry {
  serverId: string;
  hostLabel: string;
  projectId: string;
  displayName: string;
  rootPath: string;
  /** Epoch ms of the most recent agent activity in this project (0 if none). */
  lastActivityAt: number;
}

function rowItemStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.rowItem, (hovered || pressed) && styles.rowItemHovered];
}

function railItemStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.railItem, (hovered || pressed) && styles.railItemHovered];
}

function sortButtonStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.sortButton, (hovered || pressed) && styles.sortButtonHovered];
}

// Most-recent-first, falling back to name so ties (and projects with no agent
// activity) stay stable and readable.
function compareByRecent(left: ProjectEntry, right: ProjectEntry): number {
  if (left.lastActivityAt !== right.lastActivityAt) {
    return right.lastActivityAt - left.lastActivityAt;
  }
  return left.displayName.localeCompare(right.displayName);
}

function compareByName(left: ProjectEntry, right: ProjectEntry): number {
  return left.displayName.localeCompare(right.displayName);
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
      // "Modification date" per project = the freshest agent activity in it.
      // Agents don't carry a projectId directly, so bridge through the workspace
      // they run in.
      const projectByWorkspace = new Map<string, string>();
      for (const workspace of session.workspaces.values()) {
        projectByWorkspace.set(workspace.id, workspace.projectId);
      }
      const activityByProject = new Map<string, number>();
      for (const agent of session.agents.values()) {
        const projectId = agent.workspaceId ? projectByWorkspace.get(agent.workspaceId) : undefined;
        if (!projectId) {
          continue;
        }
        const at = agent.lastActivityAt.getTime();
        if (at > (activityByProject.get(projectId) ?? 0)) {
          activityByProject.set(projectId, at);
        }
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
          lastActivityAt: activityByProject.get(workspace.projectId) ?? 0,
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
          lastActivityAt: activityByProject.get(project.projectId) ?? 0,
        });
      }
    }
    // Default order feeds the desktop auto-select (first = most recent). The
    // rail re-sorts for display when the user toggles to alphabetical.
    return entries.sort(compareByRecent);
  }, [hosts, sessions]);
}

function selectProject(entry: ProjectEntry): void {
  router.setParams({ host: entry.serverId, project: entry.projectId, folder: undefined });
}

function selectFolder(folderId: string): void {
  router.setParams({ folder: folderId });
}

export function TasksScreen() {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
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
  const sortedFolders = useMemo(
    () => [...(boardHandle.board?.folders ?? [])].sort((left, right) => left.order - right.order),
    [boardHandle.board],
  );
  const selectedFolder = useMemo(
    () => sortedFolders.find((folder) => folder.id === folderId) ?? null,
    [sortedFolders, folderId],
  );

  // One-page desktop layout: keep a project and a folder selected at all times
  // so the three panes are always populated.
  const firstProject = projects[0] ?? null;
  const firstFolderId = sortedFolders[0]?.id ?? null;
  useEffect(() => {
    if (isCompact) {
      return;
    }
    if (!projectId && firstProject) {
      selectProject(firstProject);
      return;
    }
    if (projectId && boardHandle.board && !selectedFolder && firstFolderId) {
      selectFolder(firstFolderId);
    }
  }, [isCompact, projectId, firstProject, boardHandle.board, selectedFolder, firstFolderId]);

  let title = t("tasks.title");
  if (selectedFolder && isCompact) {
    title = `${t("tasks.title")} · ${selectedFolder.name}`;
  } else if (selectedProject && isCompact) {
    title = `${t("tasks.title")} · ${selectedProject.displayName}`;
  }

  return (
    <View style={styles.container}>
      <MenuHeader title={title} />
      {isCompact ? (
        <CompactFlow
          serverId={serverId}
          projectId={projectId}
          folderId={folderId}
          projects={projects}
          supportsTasksBoard={supportsTasksBoard}
          boardHandle={boardHandle}
        />
      ) : (
        <DesktopLayout
          serverId={serverId}
          projectId={projectId}
          folderId={selectedFolder?.id ?? null}
          projects={projects}
          folders={sortedFolders}
          supportsTasksBoard={supportsTasksBoard}
          boardHandle={boardHandle}
        />
      )}
    </View>
  );
}

type BoardHandle = ReturnType<typeof useTaskBoard>;

// ---------------------------------------------------------------------------
// Desktop: one-page three-pane layout — projects rail | folders rail | board.
// ---------------------------------------------------------------------------

function DesktopLayout({
  serverId,
  projectId,
  folderId,
  projects,
  folders,
  supportsTasksBoard,
  boardHandle,
}: {
  serverId: string | null;
  projectId: string | null;
  folderId: string | null;
  projects: ProjectEntry[];
  folders: TaskFolder[];
  supportsTasksBoard: boolean;
  boardHandle: BoardHandle;
}) {
  const { t } = useTranslation();

  let boardArea: React.ReactNode;
  if (!serverId || !projectId) {
    boardArea = <CenteredNote text={projects.length === 0 ? t("tasks.noProjects") : ""} />;
  } else if (!supportsTasksBoard) {
    boardArea = <CenteredNote text={t("tasks.updateHost")} />;
  } else if (boardHandle.error) {
    boardArea = <CenteredNote text={boardHandle.error} />;
  } else if (!folderId) {
    // Only show the "no folders" note once the board has actually loaded and is
    // empty. While it's still loading — or folders exist but the auto-select
    // effect hasn't picked one yet — show nothing so the note doesn't flash on
    // project open.
    const boardLoaded = boardHandle.board !== null;
    const hasFolders = (boardHandle.board?.folders.length ?? 0) > 0;
    boardArea = <CenteredNote text={boardLoaded && !hasFolders ? t("tasks.noFolders") : ""} />;
  } else {
    boardArea = (
      <BoardContent
        key={`${serverId}:${projectId}:${folderId}`}
        serverId={serverId}
        folderId={folderId}
        boardHandle={boardHandle}
      />
    );
  }

  return (
    <View style={styles.desktopRow}>
      <ProjectsRail projects={projects} serverId={serverId} projectId={projectId} />
      {serverId && projectId && supportsTasksBoard ? (
        <FoldersRail folders={folders} folderId={folderId} boardHandle={boardHandle} />
      ) : null}
      <View style={styles.boardArea}>{boardArea}</View>
    </View>
  );
}

function ProjectsRail({
  projects,
  serverId,
  projectId,
}: {
  projects: ProjectEntry[];
  serverId: string | null;
  projectId: string | null;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<ProjectSortMode>("recent");

  const displayed = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? projects.filter((entry) => entry.displayName.toLowerCase().includes(needle))
      : projects;
    return [...filtered].sort(sortMode === "name" ? compareByName : compareByRecent);
  }, [projects, query, sortMode]);

  const toggleSort = useCallback(() => {
    setSortMode((prev) => (prev === "recent" ? "name" : "recent"));
  }, []);

  let emptyText: string | null = null;
  if (projects.length === 0) {
    emptyText = t("tasks.noProjects");
  } else if (query) {
    emptyText = t("common.empty.noResults");
  }

  return (
    <View style={styles.rail}>
      <Text style={styles.railHeader}>{t("tasks.pickProject")}</Text>
      <View style={styles.railSearchRow}>
        <FormTextInput
          size="sm"
          value={query}
          onChangeText={setQuery}
          placeholder={t("tasks.searchProjects")}
          style={styles.railSearchInput}
          testID="tasks-project-search"
        />
        <Pressable
          style={sortButtonStyle}
          onPress={toggleSort}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.sortProjects")}
          testID="tasks-project-sort"
        >
          {sortMode === "name" ? (
            <ThemedSortAz size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          ) : (
            <ThemedClock size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          )}
        </Pressable>
      </View>
      <ScrollView style={styles.railScroll} contentContainerStyle={styles.railContent}>
        {emptyText ? <Text style={styles.railEmptyText}>{emptyText}</Text> : null}
        {displayed.map((entry) => (
          <ProjectRailItem
            key={`${entry.serverId}:${entry.projectId}`}
            entry={entry}
            selected={entry.serverId === serverId && entry.projectId === projectId}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const ProjectRailItem = memo(function ProjectRailItem({
  entry,
  selected,
}: {
  entry: ProjectEntry;
  selected: boolean;
}) {
  const handlePress = useCallback(() => {
    selectProject(entry);
  }, [entry]);
  return (
    <Pressable
      style={selected ? styles.railItemSelected : railItemStyle}
      onPress={handlePress}
      testID={`tasks-project-${entry.projectId}`}
    >
      <ProjectColorMark projectKey={entry.projectId} />
      <Text
        style={selected ? styles.railItemTitleSelected : styles.railItemTitle}
        numberOfLines={1}
      >
        {entry.displayName}
      </Text>
    </Pressable>
  );
});

function FoldersRail({
  folders,
  folderId,
  boardHandle,
}: {
  folders: TaskFolder[];
  folderId: string | null;
  boardHandle: BoardHandle;
}) {
  const { t } = useTranslation();
  const folderModal = useFolderModal(boardHandle);
  const taskCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of boardHandle.board?.tasks ?? []) {
      counts.set(task.folderId, (counts.get(task.folderId) ?? 0) + 1);
    }
    return counts;
  }, [boardHandle.board]);

  const totalTasks = boardHandle.board?.tasks.length ?? 0;

  return (
    <View style={styles.rail}>
      <Text style={styles.railHeader}>{t("tasks.folders")}</Text>
      <Text style={styles.railSummary}>
        {t("tasks.foldersSummary", { folders: folders.length, tasks: totalTasks })}
      </Text>
      <ScrollView style={styles.railScroll} contentContainerStyle={styles.railContent}>
        {folders.length === 0 && !boardHandle.isLoading ? (
          <Text style={styles.railEmptyText}>{t("tasks.noFolders")}</Text>
        ) : null}
        {folders.map((folder) => (
          <FolderRailItem
            key={folder.id}
            folder={folder}
            selected={folder.id === folderId}
            taskCount={taskCounts.get(folder.id) ?? 0}
            onEditFolder={folderModal.openEdit}
            onDeleteFolder={boardHandle.deleteFolder}
          />
        ))}
      </ScrollView>
      <View style={styles.railFooter}>
        <Button
          leftIcon={Plus}
          variant="secondary"
          onPress={folderModal.openCreate}
          testID="tasks-new-folder-open"
        >
          {t("tasks.actions.addFolder")}
        </Button>
      </View>
      {folderModal.element}
    </View>
  );
}

// Shared create/edit folder modal wiring: the folders rail and the compact
// folder list both open the same FolderCreateModal in either mode.
function useFolderModal(boardHandle: BoardHandle) {
  const [mode, setMode] = useState<
    { kind: "create" } | { kind: "edit"; folder: TaskFolder } | null
  >(null);

  const openCreate = useCallback(() => {
    setMode({ kind: "create" });
  }, []);
  const openEdit = useCallback((folder: TaskFolder) => {
    setMode({ kind: "edit", folder });
  }, []);
  const close = useCallback(() => {
    setMode(null);
  }, []);

  const handleSubmit = useCallback(
    (input: { name: string; color: string }) => {
      if (mode?.kind === "edit") {
        void boardHandle.updateFolder({ folderId: mode.folder.id, ...input });
      } else {
        void boardHandle.createFolder(input);
      }
    },
    [mode, boardHandle],
  );

  const initialFolder = useMemo(
    () =>
      mode?.kind === "edit" ? { name: mode.folder.name, color: mode.folder.color } : undefined,
    [mode],
  );

  const element = (
    <FolderCreateModal
      visible={mode !== null}
      onClose={close}
      onCreate={handleSubmit}
      initialFolder={initialFolder}
    />
  );

  return { openCreate, openEdit, element };
}

const FolderRailItem = memo(function FolderRailItem({
  folder,
  selected,
  taskCount,
  onEditFolder,
  onDeleteFolder,
}: {
  folder: TaskFolder;
  selected: boolean;
  taskCount: number;
  onEditFolder: (folder: TaskFolder) => void;
  onDeleteFolder: (folderId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    selectFolder(folder.id);
  }, [folder.id]);
  const handleEdit = useCallback(() => {
    onEditFolder(folder);
  }, [onEditFolder, folder]);
  const handleDelete = useCallback(() => {
    void onDeleteFolder(folder.id);
  }, [onDeleteFolder, folder.id]);
  return (
    <Pressable
      style={selected ? styles.railItemSelected : railItemStyle}
      onPress={handlePress}
      testID={`tasks-folder-${folder.id}`}
    >
      <FolderColorMark color={folder.color} />
      <View style={styles.railItemBody}>
        <Text
          style={selected ? styles.railItemTitleSelected : styles.railItemTitle}
          numberOfLines={1}
        >
          {folder.name}
        </Text>
        <Text style={styles.railItemSubtitle}>{t("tasks.taskCount", { count: taskCount })}</Text>
      </View>
      <FolderKebabMenu folderId={folder.id} onEdit={handleEdit} onDelete={handleDelete} />
    </Pressable>
  );
});

// Colored dot that mirrors the project's icon color elsewhere in the app, so a
// glance ties each rail row (and the Gantt bars) back to the same project.
const ProjectColorMark = memo(function ProjectColorMark({ projectKey }: { projectKey: string }) {
  const dotStyle = useMemo(
    () => [styles.projectColorDot, { backgroundColor: deriveProjectIconColor(projectKey) }],
    [projectKey],
  );
  return <View style={dotStyle} />;
});

const FolderColorMark = memo(function FolderColorMark({ color }: { color?: string }) {
  const dotStyle = useMemo(
    () => (color ? [styles.folderColorDot, { backgroundColor: color }] : null),
    [color],
  );
  if (!dotStyle) {
    return <ThemedFolder size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
  }
  return <View style={dotStyle} />;
});

function CenteredNote({ text }: { text: string }) {
  if (!text) {
    return <View style={styles.centered} />;
  }
  return (
    <View style={styles.centered}>
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Shared board content: add-task row + kanban columns + detail sheet.
// ---------------------------------------------------------------------------

function BoardContent({
  serverId,
  folderId,
  boardHandle,
}: {
  serverId: string | null;
  folderId: string;
  boardHandle: BoardHandle;
}) {
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [newTaskColumn, setNewTaskColumn] = useState<TaskColumn | null>(null);

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

  const handleCancelNewTask = useCallback(() => {
    setNewTaskColumn(null);
  }, []);

  const handleCreateTask = useCallback(
    ({ title, description }: { title: string; description: string }) => {
      if (!newTaskColumn) {
        return;
      }
      const targetColumn = newTaskColumn;
      setNewTaskColumn(null);
      void boardHandle.createTask({
        folderId,
        title,
        ...(description ? { description } : {}),
        column: targetColumn,
      });
    },
    [newTaskColumn, folderId, boardHandle],
  );

  const columnExtras = useMemo(
    () =>
      newTaskColumn
        ? {
            column: newTaskColumn,
            node: <NewTaskCard onSubmit={handleCreateTask} onCancel={handleCancelNewTask} />,
          }
        : null,
    [newTaskColumn, handleCreateTask, handleCancelNewTask],
  );

  const handleSaveTask = useCallback(
    ({ taskId, title, description, tags, runConfig, schedulePreference }: TaskDetailSaveInput) => {
      void boardHandle.updateTask({
        taskId,
        title,
        description: description || null,
        tags,
        runConfig,
        schedulePreference,
      });
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

  const handleApproveTask = useCallback(
    (taskId: string) => {
      void boardHandle.approveTask(taskId);
    },
    [boardHandle],
  );

  return (
    <View style={styles.boardContainer}>
      {boardHandle.board ? (
        <TaskGantt
          board={boardHandle.board}
          onPressTask={handlePressTask}
          containerStyle={styles.ganttBoardAlign}
        />
      ) : null}
      <KanbanBoard
        board={boardHandle.board}
        folderId={folderId}
        onMoveTask={handleMoveTask}
        onPressTask={handlePressTask}
        onAddTask={setNewTaskColumn}
        columnExtras={columnExtras}
      />
      <TaskDetailSheet
        serverId={serverId}
        task={detailTask}
        visible={detailTask !== null}
        onClose={handleCloseDetail}
        onSave={handleSaveTask}
        onDelete={handleDeleteTask}
        onEstimate={handleEstimateTask}
        onRunNow={handleRunTaskNow}
        onApprove={handleApproveTask}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Compact (phone): keep the drill-down flow — projects → folders → board.
// ---------------------------------------------------------------------------

function CompactFlow({
  serverId,
  projectId,
  folderId,
  projects,
  supportsTasksBoard,
  boardHandle,
}: {
  serverId: string | null;
  projectId: string | null;
  folderId: string | null;
  projects: ProjectEntry[];
  supportsTasksBoard: boolean;
  boardHandle: BoardHandle;
}) {
  const { t } = useTranslation();
  if (!serverId || !projectId) {
    return <CompactProjectPicker projects={projects} />;
  }
  if (!supportsTasksBoard) {
    return <CenteredNote text={t("tasks.updateHost")} />;
  }
  if (boardHandle.error) {
    return <CenteredNote text={boardHandle.error} />;
  }
  if (!folderId) {
    return <CompactFolderList boardHandle={boardHandle} />;
  }
  return (
    <View style={styles.compactBoardWrap}>
      <Pressable
        style={styles.backRow}
        onPress={clearFolderSelection}
        testID="tasks-back-to-folders"
      >
        <ThemedChevronLeft size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        <Text style={styles.rowSubtitle}>{t("tasks.folders")}</Text>
      </Pressable>
      <BoardContent serverId={serverId} folderId={folderId} boardHandle={boardHandle} />
    </View>
  );
}

function clearFolderSelection() {
  router.setParams({ folder: undefined });
}

function clearTasksSelection() {
  router.setParams({ host: undefined, project: undefined, folder: undefined });
}

function CompactProjectPicker({ projects }: { projects: ProjectEntry[] }) {
  const { t } = useTranslation();
  return (
    <ScrollView contentContainerStyle={styles.listContent}>
      <Text style={styles.sectionLabel}>{t("tasks.pickProject")}</Text>
      {projects.length === 0 ? <Text style={styles.emptyText}>{t("tasks.noProjects")}</Text> : null}
      {projects.map((entry) => (
        <CompactProjectRow key={`${entry.serverId}:${entry.projectId}`} entry={entry} />
      ))}
    </ScrollView>
  );
}

const CompactProjectRow = memo(function CompactProjectRow({ entry }: { entry: ProjectEntry }) {
  const handlePress = useCallback(() => {
    selectProject(entry);
  }, [entry]);
  return (
    <Pressable
      style={rowItemStyle}
      onPress={handlePress}
      testID={`tasks-project-${entry.projectId}`}
    >
      <ProjectColorMark projectKey={entry.projectId} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{entry.displayName}</Text>
        <Text style={styles.rowSubtitle}>{entry.hostLabel}</Text>
      </View>
      <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
    </Pressable>
  );
});

function CompactFolderList({ boardHandle }: { boardHandle: BoardHandle }) {
  const { t } = useTranslation();
  const folderModal = useFolderModal(boardHandle);
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

  // No detail sheet at the project level — tapping a timeline bar drills into
  // the task's folder board, where the card can be opened.
  const openTaskFolder = useCallback((task: KanbanTask) => {
    selectFolder(task.folderId);
  }, []);

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
      {boardHandle.board ? (
        <TaskGantt board={boardHandle.board} onPressTask={openTaskFolder} />
      ) : null}
      <Text style={styles.sectionLabel}>{t("tasks.folders")}</Text>
      {folders.map((folder) => (
        <CompactFolderRow
          key={folder.id}
          folder={folder}
          taskCount={taskCounts.get(folder.id) ?? 0}
          onEditFolder={folderModal.openEdit}
          onDeleteFolder={boardHandle.deleteFolder}
        />
      ))}
      {folders.length === 0 && !boardHandle.isLoading ? (
        <Text style={styles.emptyText}>{t("tasks.noFolders")}</Text>
      ) : null}
      <View style={styles.newFolderRow}>
        <Button leftIcon={Plus} onPress={folderModal.openCreate} testID="tasks-new-folder-open">
          {t("tasks.actions.addFolder")}
        </Button>
      </View>
      {folderModal.element}
    </ScrollView>
  );
}

const CompactFolderRow = memo(function CompactFolderRow({
  folder,
  taskCount,
  onEditFolder,
  onDeleteFolder,
}: {
  folder: TaskFolder;
  taskCount: number;
  onEditFolder: (folder: TaskFolder) => void;
  onDeleteFolder: (folderId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => {
    selectFolder(folder.id);
  }, [folder.id]);
  const handleEdit = useCallback(() => {
    onEditFolder(folder);
  }, [onEditFolder, folder]);
  const handleDelete = useCallback(() => {
    void onDeleteFolder(folder.id);
  }, [onDeleteFolder, folder.id]);

  return (
    <Pressable style={rowItemStyle} onPress={handleOpen} testID={`tasks-folder-${folder.id}`}>
      <FolderColorMark color={folder.color} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{folder.name}</Text>
        <Text style={styles.rowSubtitle}>{t("tasks.taskCount", { count: taskCount })}</Text>
      </View>
      <FolderKebabMenu folderId={folder.id} onEdit={handleEdit} onDelete={handleDelete} />
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  // --- Desktop three-pane layout ---
  desktopRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "stretch",
  },
  rail: {
    width: 240,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  railHeader: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  railSummary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    marginTop: -theme.spacing[1],
  },
  railSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  railSearchInput: {
    flex: 1,
  },
  sortButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  sortButtonHovered: {
    backgroundColor: theme.colors.surface3,
  },
  railScroll: {
    flex: 1,
  },
  railContent: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    gap: 2,
  },
  railItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  railItemHovered: {
    backgroundColor: theme.colors.surface2,
  },
  railItemSelected: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface3,
  },
  railItemBody: {
    flex: 1,
    gap: 1,
  },
  railItemTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  railItemTitleSelected: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  railItemSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  folderColorDot: {
    width: 10,
    height: 10,
    borderRadius: theme.borderRadius.full,
  },
  projectColorDot: {
    width: 10,
    height: 10,
    borderRadius: theme.borderRadius.full,
  },
  railEmptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
    paddingVertical: theme.spacing[4],
  },
  railFooter: {
    padding: theme.spacing[2],
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  boardArea: {
    flex: 1,
    paddingTop: theme.spacing[3],
  },
  boardContainer: {
    flex: 1,
    gap: theme.spacing[2],
  },
  // Aligns the timeline strip to the columns block below: same horizontal inset
  // as the board, capped to the columns' total width so its edges meet the
  // first and last column. Left-aligns (parent stretch + maxWidth) on wide
  // screens; on narrow screens it fills like the columns do.
  ganttBoardAlign: {
    marginHorizontal: theme.spacing[3],
    maxWidth:
      KANBAN_COLUMNS.length * KANBAN_COLUMN_MAX_WIDTH +
      (KANBAN_COLUMNS.length - 1) * theme.spacing[3],
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
  },
  // --- Compact drill-down ---
  compactBoardWrap: {
    flex: 1,
    gap: theme.spacing[1],
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
  flexInput: {
    flex: 1,
  },
}));

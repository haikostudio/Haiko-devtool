import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import Svg, { Defs, LinearGradient as SvgLinearGradient, Rect, Stop } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import {
  ArrowDownAZ,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Folder,
  LayoutGrid,
  MoreVertical,
  Pencil,
  Plus,
  Settings2,
  Trash2,
  Wand2,
  Zap,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { MenuHeader, SidebarMenuToggle } from "@/components/headers/menu-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { FolderCreateModal } from "@/components/tasks/folder-create-modal";
import { FormTextInput } from "@/components/ui/form-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FolderBillingTotal } from "@/components/tasks/folder-billing-total";
import { KanbanBoard } from "@/components/tasks/kanban-board";
import { TaskGantt } from "@/components/tasks/task-gantt";
import { NewTaskCard } from "@/components/tasks/new-task-card";
import {
  AgentBucketProvider,
  type LiveProjectBoard,
  TaskStatusVoyant,
  useFolderToneMap,
  useProjectToneMap,
} from "@/components/tasks/task-status-voyant";
import type { TaskTone } from "@/components/tasks/task-status-tone";
import { type TaskDetailSaveInput } from "@/components/tasks/task-detail-sheet";
import { TaskDetailDrawer } from "@/components/tasks/task-detail-drawer";
import { ConductorPanel } from "@/components/tasks/conductor-panel";
import { DEFAULT_TASKS_QUIET_HOURS } from "@/components/tasks/task-schedule";
import { TaskScheduleProvider } from "@/components/tasks/task-schedule-context";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useToast } from "@/contexts/toast-context";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { useTaskBoard, type KanbanTask, type TaskColumn, type TaskFolder } from "@/data/tasks";
import { PaseoDeployButton } from "@/git/paseo-deploy-button";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useBranchSwitcher } from "@/hooks/use-branch-switcher";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHosts,
} from "@/runtime/host-runtime";
import { rememberProjectBranch } from "@/stores/project-branch-selection-store";
import { useSessionStore } from "@/stores/session-store";
import { useTaskBoardToastNavStore } from "@/stores/task-board-toast-nav-store";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { deriveProjectIconColor } from "@/utils/project-icon-color";
import { buildProjectSettingsRoute } from "@/utils/host-routes";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const ThemedFolder = withUnistyles(Folder);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedTrash = withUnistyles(Trash2);
const ThemedKebab = withUnistyles(MoreVertical);
const ThemedPencil = withUnistyles(Pencil);
const ThemedClock = withUnistyles(Clock);
const ThemedSortAz = withUnistyles(ArrowDownAZ);
const ThemedZap = withUnistyles(Zap);
const ThemedSettings = withUnistyles(Settings2);
const ThemedWand = withUnistyles(Wand2);
const ThemedGradientStop = withUnistyles(Stop);
// The shadow is the theme foreground color (dark in light mode, light in dark
// mode) so it stays visible against the header surface on both themes.
const shadowStopColor = (theme: Theme) => ({ stopColor: theme.colors.foreground });

// An inner shadow on one edge of the scrollable header: a soft dark edge that
// makes the hidden content read as tucked under the rail, hinting you can slide
// it into view. Purely decorative — no taps. The shadow sits ON the given edge,
// so "left" is darkest at the left and fades toward the right, and vice-versa.
//
// The SVG is sized in explicit pixels (measured via onLayout) with a
// userSpaceOnUse gradient: percentage sizing silently paints nothing on web, so
// numeric dimensions are the only reliable option across web + native.
function HeaderScrollShadow({ side }: { side: "left" | "right" }) {
  const isLeft = side === "left";
  const [size, setSize] = useState({ width: 0, height: 0 });
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
  }, []);
  return (
    <View
      pointerEvents="none"
      onLayout={handleLayout}
      style={isLeft ? styles.headerScrollFadeLeft : styles.headerScrollFadeRight}
    >
      {size.width > 0 && size.height > 0 ? (
        <Svg width={size.width} height={size.height}>
          <Defs>
            <SvgLinearGradient
              id={`tasksHeaderShadow-${side}`}
              x1="0"
              y1="0"
              x2={size.width}
              y2="0"
              gradientUnits="userSpaceOnUse"
            >
              <ThemedGradientStop
                offset="0"
                stopOpacity={isLeft ? 0.3 : 0}
                uniProps={shadowStopColor}
              />
              <ThemedGradientStop
                offset="1"
                stopOpacity={isLeft ? 0 : 0.3}
                uniProps={shadowStopColor}
              />
            </SvgLinearGradient>
          </Defs>
          <Rect
            x={0}
            y={0}
            width={size.width}
            height={size.height}
            fill={`url(#tasksHeaderShadow-${side})`}
          />
        </Svg>
      ) : null}
    </View>
  );
}

const MENU_ICON_SIZE = 16;
// Base vertical padding for the pinned folder footer; the bottom safe-area inset
// (PWA home indicator) is added on top at render time.
const FOOTER_VERTICAL_PADDING = 12;
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

// Stable empty-array identity so the tone hooks' memos don't rebuild every
// render while a board is still loading (a fresh `[]` would look like new input).
const EMPTY_TASKS: KanbanTask[] = [];

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

// The project's checkout directory, used as the cwd for the active branch switch
// a timeline tap performs. Null when the project isn't in the loaded set yet.
function findProjectRootPath(
  projects: ProjectEntry[],
  serverId: string | null,
  projectId: string | null,
): string | null {
  if (!serverId || !projectId) {
    return null;
  }
  return (
    projects.find((entry) => entry.serverId === serverId && entry.projectId === projectId)
      ?.rootPath ?? null
  );
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

// Plain (non-Unistyles) style: FormTextInput flattens its `style` prop and strips
// Unistyles metadata, which silently drops a proxy style's flex/background. So the
// field flexes via the plain wrapper View (railSearchField) and the input just
// knocks out its own grey chrome so the white wrapper shows through — same trick as
// the column toolbar's search field.
const TRANSPARENT_CHROME = { backgroundColor: "transparent" } as const;

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

interface ProjectCounts {
  folders: number;
  tasks: number;
}

// One-shot per-project board fetch so the projects rail can show a
// "X dossier(s) · Y tâche(s)" subtitle. Runs only when the *set* of projects
// changes (the key is a value string, not the array identity, so per-tick
// session churn doesn't refetch). Desktop-only — mounted by ProjectsRail.
function useProjectTaskCounts(projects: ProjectEntry[]): Map<string, ProjectCounts> {
  const [counts, setCounts] = useState<Map<string, ProjectCounts>>(() => new Map());
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const projectKey = useMemo(
    () => projects.map((entry) => `${entry.serverId}:${entry.projectId}`).join("|"),
    [projects],
  );

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const store = getHostRuntimeStore();
      const next = new Map<string, ProjectCounts>();
      await Promise.all(
        projectsRef.current.map(async (entry) => {
          const client = store.getClient(entry.serverId);
          if (!client) {
            return;
          }
          try {
            const payload = await client.tasksBoardGet(entry.projectId);
            if (payload.board) {
              next.set(`${entry.serverId}:${entry.projectId}`, {
                folders: payload.board.folders.length,
                tasks: payload.board.tasks.length,
              });
            }
          } catch {
            // Host may not support tasks or be disconnected — skip silently.
          }
        }),
      );
      if (!cancelled) {
        setCounts(next);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectKey]);

  return counts;
}

function selectProject(entry: ProjectEntry): void {
  router.setParams({ host: entry.serverId, project: entry.projectId, folder: undefined });
}

function selectFolder(folderId: string): void {
  router.setParams({ folder: folderId });
}

function tasksHeaderTitle(
  t: ReturnType<typeof useTranslation>["t"],
  isCompact: boolean,
  selectedFolder: TaskFolder | null,
  selectedProject: ProjectEntry | null,
): string {
  if (isCompact && selectedFolder) {
    return `${t("tasks.title")} · ${selectedFolder.name}`;
  }
  if (isCompact && selectedProject) {
    return `${t("tasks.title")} · ${selectedProject.displayName}`;
  }
  return t("tasks.title");
}

// A task "owns" an agent when that agent is one of its linked conversations —
// the pipeline/primary agent or any agent-sync link. Used to map a toast (which
// carries an agent) back to its board task so a tap can open the task's drawer.
function taskOwnsAgent(task: KanbanTask, agentId: string): boolean {
  const { links } = task;
  return (
    links.primaryAgentId === agentId ||
    links.taskAgentId === agentId ||
    links.agentIds.includes(agentId)
  );
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
  const supportsAutopilot = useHostFeature(serverId, "tasksAutopilot");
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

  // Task selection (which chat the dock shows, which drawer is open) is per
  // project; drop it whenever the project changes so a stale chat/drawer never
  // lingers from another project. These store fields are ephemeral (not persisted).
  const setDockTaskId = useTasksBoardUiStore((state) => state.setDockTaskId);
  const setDetailsTaskId = useTasksBoardUiStore((state) => state.setDetailsTaskId);
  const setConductorOpen = useTasksBoardUiStore((state) => state.setConductorOpen);
  useEffect(() => {
    setDockTaskId(null);
    setDetailsTaskId(null);
  }, [serverId, projectId, setDockTaskId, setDetailsTaskId]);

  // While the board is on screen, teach the global agent-task toast stack to open
  // a task's drawer instead of navigating to its raw agent — the same thing a card
  // tap does (dock the task's chat when the conductor is available, otherwise pop
  // the Details drawer). The latest board/serverId live in refs so the registered
  // resolver stays stable and doesn't re-register on every board refresh.
  const supportsConductor = useHostFeature(serverId, "tasksConductor");
  const setResolveAgentTask = useTaskBoardToastNavStore((state) => state.setResolveAgentTask);
  const boardRef = useRef(boardHandle.board);
  const serverIdRef = useRef(serverId);
  const supportsConductorRef = useRef(supportsConductor);
  useEffect(() => {
    boardRef.current = boardHandle.board;
    serverIdRef.current = serverId;
    supportsConductorRef.current = supportsConductor;
  });
  useEffect(() => {
    setResolveAgentTask(({ serverId: targetServerId, agentId }) => {
      if (!serverIdRef.current || serverIdRef.current !== targetServerId) {
        return false;
      }
      const task = boardRef.current?.tasks.find((entry) => taskOwnsAgent(entry, agentId));
      if (!task) {
        return false;
      }
      if (supportsConductorRef.current) {
        setDockTaskId(task.id);
        setConductorOpen(true);
      } else {
        setDetailsTaskId(task.id);
      }
      return true;
    });
    return () => setResolveAgentTask(null);
  }, [setResolveAgentTask, setDockTaskId, setDetailsTaskId, setConductorOpen]);

  const title = tasksHeaderTitle(t, isCompact, selectedFolder, selectedProject);

  return (
    <AgentBucketProvider>
      <View style={styles.container}>
        <TasksHeader
          title={title}
          isCompact={isCompact}
          supportsTasksBoard={supportsTasksBoard}
          selectedProject={selectedProject}
          selectedFolder={selectedFolder}
          projects={projects}
          folders={sortedFolders}
        />
        {isCompact ? (
          <CompactFlow
            serverId={serverId}
            projectId={projectId}
            folderId={folderId}
            projects={projects}
            supportsTasksBoard={supportsTasksBoard}
            supportsAutopilot={supportsAutopilot}
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
            supportsAutopilot={supportsAutopilot}
            boardHandle={boardHandle}
          />
        )}
        <ConductorDock serverId={serverId} projectId={projectId} boardHandle={boardHandle} />
        {/* Rendered after the conductor dock so, when both are open, the Details
            drawer stacks above the chat instead of hiding behind it. */}
        <TasksDetailDock serverId={serverId} projectId={projectId} boardHandle={boardHandle} />
      </View>
    </AgentBucketProvider>
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
  supportsAutopilot,
  boardHandle,
}: {
  serverId: string | null;
  projectId: string | null;
  folderId: string | null;
  projects: ProjectEntry[];
  folders: TaskFolder[];
  supportsTasksBoard: boolean;
  supportsAutopilot: boolean;
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
        projectId={projectId}
        projectRootPath={findProjectRootPath(projects, serverId, projectId)}
        folderId={folderId}
        boardHandle={boardHandle}
      />
    );
  }

  return (
    <View style={styles.desktopRow}>
      <ProjectsRail
        projects={projects}
        serverId={serverId}
        projectId={projectId}
        boardHandle={boardHandle}
      />
      {serverId && projectId && supportsTasksBoard ? (
        <FoldersRail
          folders={folders}
          folderId={folderId}
          supportsAutopilot={supportsAutopilot}
          boardHandle={boardHandle}
        />
      ) : null}
      <View style={styles.boardArea}>{boardArea}</View>
    </View>
  );
}

function ProjectsRail({
  projects,
  serverId,
  projectId,
  boardHandle,
}: {
  projects: ProjectEntry[];
  serverId: string | null;
  projectId: string | null;
  boardHandle: BoardHandle;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<ProjectSortMode>("recent");
  const counts = useProjectTaskCounts(projects);
  // Feed the selected project's live board in so its dot animates the instant a
  // child task starts, without waiting for the rail's periodic re-poll.
  const liveBoard = useMemo<LiveProjectBoard | null>(
    () =>
      serverId && projectId && boardHandle.board
        ? { key: `${serverId}:${projectId}`, tasks: boardHandle.board.tasks }
        : null,
    [serverId, projectId, boardHandle.board],
  );
  const tones = useProjectToneMap(projects, liveBoard);

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
        <View style={styles.railSearchField}>
          <FormTextInput
            size="sm"
            value={query}
            onChangeText={setQuery}
            placeholder={t("tasks.searchProjects")}
            style={TRANSPARENT_CHROME}
            testID="tasks-project-search"
          />
        </View>
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
            counts={counts.get(`${entry.serverId}:${entry.projectId}`) ?? null}
            tone={tones.get(`${entry.serverId}:${entry.projectId}`) ?? null}
          />
        ))}
      </ScrollView>
    </View>
  );
}

const ProjectRailItem = memo(function ProjectRailItem({
  entry,
  selected,
  counts,
  tone,
}: {
  entry: ProjectEntry;
  selected: boolean;
  counts: ProjectCounts | null;
  tone: TaskTone | null;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    selectProject(entry);
  }, [entry]);
  // Gear → the project's configuration sheet (name, icon, billing client, …).
  const handleOpenSettings = useCallback(() => {
    router.navigate(buildProjectSettingsRoute(entry.projectId));
  }, [entry.projectId]);
  return (
    <Pressable
      style={selected ? styles.railItemSelected : railItemStyle}
      onPress={handlePress}
      testID={`tasks-project-${entry.projectId}`}
    >
      <ProjectColorMark projectKey={entry.projectId} />
      <View style={styles.railItemBody}>
        <Text
          style={selected ? styles.railItemTitleSelected : styles.railItemTitle}
          numberOfLines={1}
        >
          {entry.displayName}
        </Text>
        {counts && (counts.folders > 0 || counts.tasks > 0) ? (
          <Text style={styles.railItemSubtitle} numberOfLines={1}>
            {t("tasks.foldersSummary", { folders: counts.folders, tasks: counts.tasks })}
          </Text>
        ) : null}
      </View>
      <TaskStatusVoyant tone={tone} />
      <Pressable
        onPress={handleOpenSettings}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("sidebar.project.actions.openSettings")}
        testID={`tasks-project-settings-${entry.projectId}`}
        style={styles.railItemAction}
      >
        <ThemedSettings size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      </Pressable>
    </Pressable>
  );
});

function FoldersRail({
  folders,
  folderId,
  supportsAutopilot,
  boardHandle,
}: {
  folders: TaskFolder[];
  folderId: string | null;
  supportsAutopilot: boolean;
  boardHandle: BoardHandle;
}) {
  const { t } = useTranslation();
  const folderModal = useFolderModal(boardHandle, supportsAutopilot);
  const taskCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of boardHandle.board?.tasks ?? []) {
      counts.set(task.folderId, (counts.get(task.folderId) ?? 0) + 1);
    }
    return counts;
  }, [boardHandle.board]);
  const folderTones = useFolderToneMap(boardHandle.board?.tasks ?? EMPTY_TASKS);

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
            tone={folderTones.get(folder.id) ?? null}
            onEditFolder={folderModal.openEdit}
            onDeleteFolder={boardHandle.deleteFolder}
          />
        ))}
      </ScrollView>
      <View style={styles.railFooter}>
        <Button
          leftIcon={Plus}
          variant="secondary"
          size="sm"
          onPress={folderModal.openCreate}
          style={styles.addButton}
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
function useFolderModal(boardHandle: BoardHandle, supportsAutopilot: boolean) {
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
    (input: { name: string; color: string; autopilot?: boolean; branch?: string }) => {
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
      mode?.kind === "edit"
        ? {
            name: mode.folder.name,
            color: mode.folder.color,
            autopilot: mode.folder.autopilot,
            branch: mode.folder.branch,
          }
        : undefined,
    [mode],
  );

  const element = (
    <FolderCreateModal
      visible={mode !== null}
      onClose={close}
      onCreate={handleSubmit}
      initialFolder={initialFolder}
      showAutopilot={supportsAutopilot}
    />
  );

  return { openCreate, openEdit, element };
}

const FolderRailItem = memo(function FolderRailItem({
  folder,
  selected,
  taskCount,
  tone,
  onEditFolder,
  onDeleteFolder,
}: {
  folder: TaskFolder;
  selected: boolean;
  taskCount: number;
  tone: TaskTone | null;
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
        {folder.branch ? (
          <Text style={styles.railItemBranch} numberOfLines={1}>
            {folder.branch}
          </Text>
        ) : null}
        <Text style={styles.railItemSubtitle}>{t("tasks.taskCount", { count: taskCount })}</Text>
      </View>
      <TaskStatusVoyant tone={tone} />
      {folder.autopilot ? <AutopilotMark /> : null}
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

// Lightning mark on folders whose backlog runs on autopilot.
const AutopilotMark = memo(function AutopilotMark() {
  const { t } = useTranslation();
  return (
    <View accessibilityLabel={t("tasks.folderModal.autopilotField")}>
      <ThemedZap size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
    </View>
  );
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

// Compact board view toggle: the timeline moves behind a tab instead of
// stacking above the kanban, so the board owns the screen by default and the
// Gantt gets full height when picked.
type CompactBoardView = "board" | "timeline";

// A task's title is the first non-empty line of its prompt, trimmed of leading
// list markers and capped so the kanban card stays one line. The full prompt is
// kept as the description; the analysis agent refines the title later.
const MAX_DERIVED_TITLE_CHARS = 80;
function deriveTaskTitle(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim().length > 0) ?? "";
  const cleaned = firstLine.replace(/^\s*(?:[-*+•]|\[[ xX]\]|\d+[.)])\s*/, "").trim();
  return cleaned.length > MAX_DERIVED_TITLE_CHARS
    ? `${cleaned.slice(0, MAX_DERIVED_TITLE_CHARS).trimEnd()}…`
    : cleaned;
}

const renderBoardIcon = ({ color, size }: { color: string; size: number }) => (
  <LayoutGrid color={color} size={size} />
);
const renderTimelineIcon = ({ color, size }: { color: string; size: number }) => (
  <Clock color={color} size={size} />
);

function BoardContent({
  serverId,
  projectId,
  projectRootPath,
  folderId,
  boardHandle,
}: {
  serverId: string | null;
  projectId: string | null;
  projectRootPath: string | null;
  folderId: string;
  boardHandle: BoardHandle;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const isCompact = useIsCompactFormFactor();
  const { config } = useDaemonConfig(serverId);
  const quietHours = config?.tasks?.quietHours ?? DEFAULT_TASKS_QUIET_HOURS;

  // The active branch switch operates on the project's main checkout (its root
  // path). We reuse the very hook the sidebar branch switcher drives, so a
  // timeline tap performs the exact same real checkout — stash prompt, toasts and
  // query invalidation included — not just a note for next reload.
  const branchSwitchServerId = serverId ?? "";
  const checkoutCwd = projectRootPath ?? "";
  const client = useHostRuntimeClient(branchSwitchServerId);
  const isConnected = useHostRuntimeIsConnected(branchSwitchServerId);
  const { status: checkoutStatus } = useCheckoutStatusQuery({
    serverId: branchSwitchServerId,
    cwd: checkoutCwd,
  });
  const currentBranchName =
    checkoutStatus?.currentBranch && checkoutStatus.currentBranch !== "HEAD"
      ? checkoutStatus.currentBranch
      : null;
  const { handleBranchSelect } = useBranchSwitcher({
    client,
    normalizedServerId: branchSwitchServerId,
    normalizedWorkspaceId: projectId ?? checkoutCwd,
    workspaceDirectory: checkoutCwd || null,
    currentBranchName,
    isGitCheckout: Boolean(checkoutCwd),
    isConnected,
    toast,
    queryClient,
  });
  // Tapping a task on a host without the conductor opens its Details+Billing
  // drawer directly. The drawer itself lives at the screen root (TasksDetailDock)
  // so it docks beside the conductor chat and stacks above it, never behind.
  const setDetailsTaskId = useTasksBoardUiStore((state) => state.setDetailsTaskId);
  // Tapping a task points the shared bottom dock at its agent chat.
  const setDockTaskId = useTasksBoardUiStore((state) => state.setDockTaskId);
  const setConductorOpen = useTasksBoardUiStore((state) => state.setConductorOpen);
  const supportsConductor = useHostFeature(serverId, "tasksConductor");
  const [newTaskColumn, setNewTaskColumn] = useState<TaskColumn | null>(null);
  const [compactView, setCompactView] = useState<CompactBoardView>("board");

  const viewOptions = useMemo<SegmentedControlOption<CompactBoardView>[]>(
    () => [
      {
        value: "board",
        label: t("tasks.view.board"),
        icon: renderBoardIcon,
        testID: "tasks-view-board",
      },
      {
        value: "timeline",
        label: t("tasks.view.timeline"),
        icon: renderTimelineIcon,
        testID: "tasks-view-timeline",
      },
    ],
    [t],
  );

  // Tasks in the open folder, for the folder's glanceable billable total.
  const folderTasks = useMemo(
    () => (boardHandle.board?.tasks ?? []).filter((task) => task.folderId === folderId),
    [boardHandle.board, folderId],
  );

  const handleMoveTask = useCallback(
    (input: { taskId: string; column: TaskColumn; index: number }) => {
      void boardHandle.moveTask(input);
    },
    [boardHandle],
  );

  // Tapping a task (board card or Gantt bar) opens its agent chat in the shared
  // bottom dock. The Details+Billing drawer is opened separately, from the dock
  // header's "Details" button — the two surfaces are independent. Hosts without
  // the conductor feature have no dock, so there we open the Details drawer
  // directly (otherwise a task tap would do nothing visible).
  const handlePressTask = useCallback(
    (task: KanbanTask) => {
      // Remember this card has been seen (persistent, idempotent). A finished
      // card then dims once opened; still-unseen finished cards stay bright.
      void boardHandle.markTaskViewed(task.id).catch(() => {
        // Best-effort — a failed stamp just leaves the card at full opacity.
      });
      if (supportsConductor) {
        setDockTaskId(task.id);
        setConductorOpen(true);
      } else {
        setDetailsTaskId(task.id);
      }
    },
    [supportsConductor, setDockTaskId, setConductorOpen, setDetailsTaskId, boardHandle],
  );

  // Tapping a task on the timeline does everything a card tap does (open its
  // drawer/dock) AND immediately switches the project onto that task's git branch
  // — the same active checkout the sidebar branch switcher performs, not just a
  // note read back on reload. A task's branch is the one its agent runs on once
  // launched (links.branch), falling back to its folder's shared branch. When a
  // task has neither (agent not launched, no folder branch) we only open the
  // drawer and say so discreetly. Persistence is kept on top of the live switch,
  // so a reload still restores the same branch.
  const handlePressTimelineTask = useCallback(
    (task: KanbanTask) => {
      handlePressTask(task);
      if (!serverId || !projectId) {
        return;
      }
      const folder = boardHandle.board?.folders.find((entry) => entry.id === task.folderId);
      const branch = task.links.branch ?? folder?.branch ?? null;
      if (!branch) {
        toast.show(t("tasks.gantt.noBranchToSwitch"));
        return;
      }
      handleBranchSelect(branch);
      rememberProjectBranch({ serverId, projectId, branch });
    },
    [handlePressTask, serverId, projectId, boardHandle.board, handleBranchSelect, toast, t],
  );

  const handleCancelNewTask = useCallback(() => {
    setNewTaskColumn(null);
  }, []);

  const handleCreateTask = useCallback(
    ({ text, attachments }: { text: string; attachments: AgentAttachment[] }) => {
      if (!newTaskColumn) {
        return;
      }
      const targetColumn = newTaskColumn;
      // The prompt IS the task: derive a short title from its first line and
      // keep the full prompt as the description the pipeline agent works from.
      // No prompt text means there's nothing to describe — treat it as a cancel.
      const title = deriveTaskTitle(text);
      if (!title) {
        setNewTaskColumn(null);
        return;
      }
      setNewTaskColumn(null);
      void boardHandle.createTask({
        folderId,
        title,
        description: text,
        ...(attachments.length > 0 ? { attachments } : {}),
        column: targetColumn,
      });
    },
    [newTaskColumn, folderId, boardHandle],
  );

  const columnExtras = useMemo(
    () =>
      newTaskColumn && serverId
        ? {
            column: newTaskColumn,
            node: (
              <NewTaskCard
                serverId={serverId}
                cwd=""
                draftKey={`tasks-new:${folderId}:${newTaskColumn}`}
                onSubmit={handleCreateTask}
                onCancel={handleCancelNewTask}
              />
            ),
          }
        : null,
    [newTaskColumn, serverId, folderId, handleCreateTask, handleCancelNewTask],
  );

  const handleEstimateTask = useCallback(
    (taskId: string) => {
      toast.show(t("tasks.toast.reanalyzing"));
      boardHandle.estimateTask(taskId).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [boardHandle, toast, t],
  );

  const handleRunTaskNow = useCallback(
    (taskId: string) => {
      toast.show(t("tasks.toast.launching"));
      boardHandle.runTaskNow(taskId).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [boardHandle, toast, t],
  );

  // The card menu already confirmed the deletion; here we just perform it. The
  // card leaves the board on its own via the live task sync.
  const handleDeleteTask = useCallback(
    (taskId: string) => {
      boardHandle.deleteTask(taskId).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [boardHandle, toast],
  );

  // Desktop keeps the strip-above-board layout; compact swaps to one-at-a-time
  // tabs so neither view is squeezed.
  const showTimeline = !isCompact || compactView === "timeline";
  const showBoard = !isCompact || compactView === "board";

  const boardStack = (
    <View style={isCompact ? styles.boardContainerCompact : styles.boardContainer}>
      {isCompact ? (
        <View style={styles.compactViewSwitch}>
          <SegmentedControl
            options={viewOptions}
            value={compactView}
            onValueChange={setCompactView}
            size="sm"
            fullWidth
            testID="tasks-view-switch"
          />
        </View>
      ) : null}
      <FolderBillingTotal serverId={serverId} projectId={projectId} tasks={folderTasks} />
      {boardHandle.board && showTimeline ? (
        <TaskGantt
          board={boardHandle.board}
          onPressTask={handlePressTimelineTask}
          containerStyle={isCompact ? undefined : styles.ganttBoardAlign}
          fill={isCompact}
        />
      ) : null}
      {showBoard ? (
        <KanbanBoard
          board={boardHandle.board}
          folderId={folderId}
          onMoveTask={handleMoveTask}
          onPressTask={handlePressTask}
          onAddTask={setNewTaskColumn}
          onRunTask={handleRunTaskNow}
          onReanalyzeTask={handleEstimateTask}
          onDeleteTask={handleDeleteTask}
          columnExtras={columnExtras}
        />
      ) : null}
    </View>
  );

  return <TaskScheduleProvider value={quietHours}>{boardStack}</TaskScheduleProvider>;
}

// Task actions bound to a board handle, shared by the conductor dock (its
// Details tab) and the standalone Details/Billing drawer so the two never drift.
function useBoardTaskActions(boardHandle: BoardHandle) {
  const { t } = useTranslation();
  const toast = useToast();
  const handleSave = useCallback(
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
  const handleDelete = useCallback(
    (taskId: string) => {
      void boardHandle.deleteTask(taskId);
    },
    [boardHandle],
  );
  const handleEstimate = useCallback(
    (taskId: string) => {
      toast.show(t("tasks.toast.reanalyzing"));
      boardHandle.estimateTask(taskId).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [boardHandle, toast, t],
  );
  const handleRunNow = useCallback(
    (taskId: string) => {
      toast.show(t("tasks.toast.launching"));
      boardHandle.runTaskNow(taskId).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [boardHandle, toast, t],
  );
  const handleApprove = useCallback(
    (taskId: string) => {
      void boardHandle.approveTask(taskId);
    },
    [boardHandle],
  );
  const handleSetHold = useCallback(
    (taskId: string, hold: boolean) => {
      boardHandle.updateTask({ taskId, executionHold: hold }).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [boardHandle, toast],
  );
  return { handleSave, handleDelete, handleEstimate, handleRunNow, handleApprove, handleSetHold };
}

// Bottom-center floating toggle + the shared chat dock overlay. Gated on the
// host feature flag; rendered at the TasksScreen root so its absolute position
// centers across the full tasks area (including rails), not just the board. The
// dock shows the conductor agent by default and, when a task is tapped on the
// board, that task's Chat / Details / Billing tabs.
function ConductorDock({
  serverId,
  projectId,
  boardHandle,
}: {
  serverId: string | null;
  projectId: string | null;
  boardHandle: BoardHandle;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const supportsConductor = useHostFeature(serverId, "tasksConductor");
  const conductorOpen = useTasksBoardUiStore((state) => state.conductorOpen);
  const setConductorOpen = useTasksBoardUiStore((state) => state.setConductorOpen);
  const dockTaskId = useTasksBoardUiStore((state) => state.dockTaskId);
  const setDockTaskId = useTasksBoardUiStore((state) => state.setDockTaskId);
  const taskActions = useBoardTaskActions(boardHandle);

  const dockTask = useMemo(
    () =>
      dockTaskId ? (boardHandle.board?.tasks.find((task) => task.id === dockTaskId) ?? null) : null,
    [dockTaskId, boardHandle.board],
  );

  // Closing the dock also drops the task selection so it never reopens pointed at
  // a task that has since gone away.
  const handleClose = useCallback(() => {
    setConductorOpen(false);
    setDockTaskId(null);
  }, [setConductorOpen, setDockTaskId]);
  const handleOpen = useCallback(() => setConductorOpen(true), [setConductorOpen]);
  const handleBack = useCallback(() => setDockTaskId(null), [setDockTaskId]);

  // Proximity animation (desktop web only): the toggle fades in and grows as the
  // cursor approaches, then springs back to dormant when it moves away. On touch
  // (compact) there's no cursor, so the toggle starts fully visible instead.
  const proximityEnabled = isWeb && !isCompact;
  const wrapperRef = useRef<View>(null);
  const scaleAnim = useRef(new Animated.Value(proximityEnabled ? 0.85 : 1)).current;
  const opacityAnim = useRef(new Animated.Value(proximityEnabled ? 0.5 : 1)).current;
  const nearRef = useRef(false);

  useEffect(() => {
    if (!proximityEnabled || conductorOpen) return;

    const onMouseMove = (e: MouseEvent) => {
      const el = wrapperRef.current as unknown as HTMLElement | null;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.sqrt((e.clientX - cx) ** 2 + (e.clientY - cy) ** 2);
      const near = dist < 140;
      if (near === nearRef.current) return;
      nearRef.current = near;
      Animated.parallel([
        Animated.spring(scaleAnim, { toValue: near ? 1 : 0.85, useNativeDriver: false }),
        Animated.timing(opacityAnim, {
          toValue: near ? 1 : 0.5,
          duration: 180,
          useNativeDriver: false,
        }),
      ]).start();
    };

    window.addEventListener("mousemove", onMouseMove);
    return () => window.removeEventListener("mousemove", onMouseMove);
  }, [proximityEnabled, conductorOpen, scaleAnim, opacityAnim]);

  const wrapperAnimStyle = useMemo(
    () => [
      styles.conductorToggleWrapper,
      { transform: [{ scale: scaleAnim }], opacity: opacityAnim },
    ],
    // scaleAnim/opacityAnim are stable Animated.Value refs; the memo is only
    // for the outer array allocation so the lint rule is satisfied.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  if (!supportsConductor || !projectId) {
    return null;
  }
  if (conductorOpen) {
    return (
      <ConductorPanel
        serverId={serverId}
        projectId={projectId}
        dockTask={dockTask}
        onBackToConductor={handleBack}
        onRunNow={taskActions.handleRunNow}
        onSave={taskActions.handleSave}
        onDelete={taskActions.handleDelete}
        onEstimate={taskActions.handleEstimate}
        onApprove={taskActions.handleApprove}
        onSetHold={taskActions.handleSetHold}
        onClose={handleClose}
      />
    );
  }
  return (
    <Animated.View ref={wrapperRef} style={wrapperAnimStyle}>
      <Pressable
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel={t("tasks.conductor.title")}
        style={styles.conductorToggle}
        testID="tasks-conductor-toggle"
      >
        <ThemedWand size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        <Text style={styles.conductorToggleLabel} numberOfLines={1}>
          {t("tasks.conductor.title")}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

// The task's Details+Billing drawer, rendered at the TasksScreen root (after the
// conductor dock) so it docks beside the conductor chat and stacks above it. Open
// state lives in the board store: the conductor dock's "Details" button and a
// task tap on non-conductor hosts both set `detailsTaskId`.
function TasksDetailDock({
  serverId,
  projectId,
  boardHandle,
}: {
  serverId: string | null;
  projectId: string | null;
  boardHandle: BoardHandle;
}) {
  const detailsTaskId = useTasksBoardUiStore((state) => state.detailsTaskId);
  const setDetailsTaskId = useTasksBoardUiStore((state) => state.setDetailsTaskId);

  const detailsTask = useMemo(
    () =>
      detailsTaskId
        ? (boardHandle.board?.tasks.find((task) => task.id === detailsTaskId) ?? null)
        : null,
    [detailsTaskId, boardHandle.board],
  );

  const handleClose = useCallback(() => setDetailsTaskId(null), [setDetailsTaskId]);
  const taskActions = useBoardTaskActions(boardHandle);

  return (
    <TaskDetailDrawer
      serverId={serverId}
      projectId={projectId}
      task={detailsTask}
      visible={detailsTask !== null}
      onClose={handleClose}
      onSave={taskActions.handleSave}
      onDelete={taskActions.handleDelete}
      onEstimate={taskActions.handleEstimate}
      onRunNow={taskActions.handleRunNow}
      onApprove={taskActions.handleApprove}
      onSetHold={taskActions.handleSetHold}
    />
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
  supportsAutopilot,
  boardHandle,
}: {
  serverId: string | null;
  projectId: string | null;
  folderId: string | null;
  projects: ProjectEntry[];
  supportsTasksBoard: boolean;
  supportsAutopilot: boolean;
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
    return <CompactFolderList boardHandle={boardHandle} supportsAutopilot={supportsAutopilot} />;
  }
  return (
    <View style={styles.compactBoardWrap}>
      <BoardContent
        serverId={serverId}
        projectId={projectId}
        projectRootPath={findProjectRootPath(projects, serverId, projectId)}
        folderId={folderId}
        boardHandle={boardHandle}
      />
    </View>
  );
}

function clearFolderSelection() {
  router.setParams({ folder: undefined });
}

function clearTasksSelection() {
  router.setParams({ host: undefined, project: undefined, folder: undefined });
}

const FolderSelectorItem = memo(function FolderSelectorItem({ folder }: { folder: TaskFolder }) {
  const leading = useMemo(() => <FolderColorMark color={folder.color} />, [folder.color]);
  const handleSelect = useCallback(() => {
    selectFolder(folder.id);
  }, [folder.id]);
  return (
    <DropdownMenuItem
      leading={leading}
      onSelect={handleSelect}
      testID={`tasks-header-folder-${folder.id}`}
    >
      {folder.name}
    </DropdownMenuItem>
  );
});

// Project pill for the board header (name + dropdown), followed by a "/" divider.
// Extracted so the header's JSX stays under the max-depth lint budget.
function BoardProjectSelector({
  currentProject,
  projects,
}: {
  currentProject: ProjectEntry;
  projects: ProjectEntry[];
}) {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={styles.folderSelector}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.pickProject")}
          testID="tasks-header-board-project-selector"
        >
          <ProjectColorMark projectKey={currentProject.projectId} />
          <Text style={styles.folderSelectorLabel} numberOfLines={1}>
            {currentProject.displayName}
          </Text>
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" width={240}>
          {projects.map((entry) => (
            <ProjectSelectorItem key={`${entry.serverId}:${entry.projectId}`} entry={entry} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Text style={styles.headerSeparator}>/</Text>
    </>
  );
}

// Folder pill for the board header (name + dropdown to switch folders in place).
function BoardFolderSelector({
  currentFolder,
  folders,
}: {
  currentFolder: TaskFolder;
  folders: TaskFolder[];
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.folderSelector}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("tasks.folders")}
        testID="tasks-header-folder-selector"
      >
        <FolderColorMark color={currentFolder.color} />
        <Text style={styles.folderSelectorLabel} numberOfLines={1}>
          {currentFolder.name}
        </Text>
        <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={240}>
        {folders.map((folder) => (
          <FolderSelectorItem key={folder.id} folder={folder} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Picks the right header for the current drill-down level. On mobile the header
// owns navigation: at the folder-list level it switches projects, on a board it
// switches folders; everywhere else it's the plain menu header.
/**
 * Deploy ("Publier") button for the task manager header — same gate as the
 * workspace header: only the Paseo repo itself, and only when the host
 * advertises the `paseoSelfhostDeploy` capability.
 */
function TasksDeployButton({ project }: { project: ProjectEntry | null }) {
  const supported = useSessionStore((s) =>
    project
      ? s.sessions[project.serverId]?.serverInfo?.features?.paseoSelfhostDeploy === true
      : false,
  );
  if (!project || !supported || project.rootPath !== "/root/paseo") return null;
  return <PaseoDeployButton serverId={project.serverId} projectId={project.projectId} compact />;
}

function TasksHeader({
  title,
  isCompact,
  supportsTasksBoard,
  selectedProject,
  selectedFolder,
  projects,
  folders,
}: {
  title: string;
  isCompact: boolean;
  supportsTasksBoard: boolean;
  selectedProject: ProjectEntry | null;
  selectedFolder: TaskFolder | null;
  projects: ProjectEntry[];
  folders: TaskFolder[];
}) {
  // Top-right cluster: the deploy rocket (Paseo repo only) sits next to the
  // project gear, which stays one tap away on every drill-down level.
  const rightContent = useMemo(
    () => (
      <View style={styles.headerRightCluster}>
        <TasksDeployButton project={selectedProject} />
        {selectedProject ? <ProjectSettingsButton projectId={selectedProject.projectId} /> : null}
      </View>
    ),
    [selectedProject],
  );
  if (isCompact && supportsTasksBoard && selectedFolder) {
    return (
      <CompactBoardHeader
        currentFolder={selectedFolder}
        folders={folders}
        currentProject={selectedProject}
        projects={projects}
        right={rightContent}
      />
    );
  }
  if (isCompact && supportsTasksBoard && selectedProject) {
    return (
      <CompactProjectHeader
        currentProject={selectedProject}
        projects={projects}
        right={rightContent}
      />
    );
  }
  return <MenuHeader title={title} rightContent={rightContent} />;
}

// Mobile board header: hamburger + back-to-folders chevron + a folder-name
// dropdown that switches folders in place. Replaces the old separate "‹ Dossiers"
// row so the navigation lives in a single, obvious bar.
function CompactBoardHeader({
  currentFolder,
  folders,
  currentProject,
  projects,
  right,
}: {
  currentFolder: TaskFolder;
  folders: TaskFolder[];
  currentProject: ProjectEntry | null;
  projects: ProjectEntry[];
  right?: ReactNode;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<ScrollView>(null);
  const containerWidthRef = useRef(0);
  const contentWidthRef = useRef(0);
  const offsetRef = useRef(0);
  const didAutoScrollRef = useRef(false);
  const [fades, setFades] = useState({ left: false, right: false });

  // Each edge fades only when there's hidden content past it: the left fade means
  // "scrolled-off content to the left", the right fade means "more to the right".
  // Both vanish once you reach the corresponding end.
  const refreshFade = useCallback(() => {
    const overflow = contentWidthRef.current - containerWidthRef.current;
    if (overflow <= 1) {
      setFades((prev) => (prev.left || prev.right ? { left: false, right: false } : prev));
      return;
    }
    const offset = offsetRef.current;
    const next = { left: offset > 1, right: offset < overflow - 1 };
    setFades((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
  }, []);

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      containerWidthRef.current = event.nativeEvent.layout.width;
      refreshFade();
    },
    [refreshFade],
  );

  // First time the content is measured wider than the rail, jump to the end so
  // the active folder (rightmost item) is the one in view.
  const handleContentSizeChange = useCallback(
    (width: number) => {
      contentWidthRef.current = width;
      if (!didAutoScrollRef.current && width > containerWidthRef.current + 1) {
        didAutoScrollRef.current = true;
        scrollRef.current?.scrollToEnd({ animated: false });
        // scrollToEnd is programmatic and may not emit onScroll, so mirror the
        // resulting offset ourselves — otherwise the left shadow never lights up.
        offsetRef.current = width - containerWidthRef.current;
      }
      refreshFade();
    },
    [refreshFade],
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      offsetRef.current = event.nativeEvent.contentOffset.x;
      refreshFade();
    },
    [refreshFade],
  );

  return (
    <ScreenHeader
      leftStyle={styles.boardHeaderLeft}
      left={
        <>
          <SidebarMenuToggle />
          <Pressable
            onPress={clearFolderSelection}
            hitSlop={8}
            style={styles.boardHeaderBack}
            accessibilityRole="button"
            accessibilityLabel={t("tasks.folders")}
            testID="tasks-header-back"
          >
            <ThemedChevronLeft size={ICON_SIZE.md} uniProps={mutedColorMapping} />
          </Pressable>
          <View style={styles.boardHeaderScrollWrap}>
            <ScrollView
              ref={scrollRef}
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.boardHeaderScroll}
              contentContainerStyle={styles.boardHeaderScrollContent}
              keyboardShouldPersistTaps="handled"
              onLayout={handleLayout}
              onContentSizeChange={handleContentSizeChange}
              onScroll={handleScroll}
              scrollEventThrottle={16}
            >
              {currentProject ? (
                <BoardProjectSelector currentProject={currentProject} projects={projects} />
              ) : null}
              <BoardFolderSelector currentFolder={currentFolder} folders={folders} />
            </ScrollView>
            {fades.left ? <HeaderScrollShadow side="left" /> : null}
            {fades.right ? <HeaderScrollShadow side="right" /> : null}
          </View>
        </>
      }
      right={right}
    />
  );
}

const ProjectSelectorItem = memo(function ProjectSelectorItem({ entry }: { entry: ProjectEntry }) {
  const leading = useMemo(
    () => <ProjectColorMark projectKey={entry.projectId} />,
    [entry.projectId],
  );
  const handleSelect = useCallback(() => {
    selectProject(entry);
  }, [entry]);
  return (
    <DropdownMenuItem
      leading={leading}
      onSelect={handleSelect}
      testID={`tasks-header-project-${entry.projectId}`}
    >
      {entry.displayName}
    </DropdownMenuItem>
  );
});

// Mobile folder-list header: hamburger + back-to-projects chevron + a
// project-name dropdown that switches projects in place. Mirrors
// CompactBoardHeader so the two drill-down levels share one navigation pattern.
function CompactProjectHeader({
  currentProject,
  projects,
  right,
}: {
  currentProject: ProjectEntry;
  projects: ProjectEntry[];
  right?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <ScreenHeader
      leftStyle={styles.boardHeaderLeft}
      left={
        <>
          <SidebarMenuToggle />
          <Pressable
            onPress={clearTasksSelection}
            hitSlop={8}
            style={styles.boardHeaderBack}
            accessibilityRole="button"
            accessibilityLabel={t("tasks.allProjects")}
            testID="tasks-back-to-projects"
          >
            <ThemedChevronLeft size={ICON_SIZE.md} uniProps={mutedColorMapping} />
          </Pressable>
          <DropdownMenu>
            <DropdownMenuTrigger
              style={styles.folderSelector}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t("tasks.pickProject")}
              testID="tasks-header-project-selector"
            >
              <ProjectColorMark projectKey={currentProject.projectId} />
              <Text style={styles.folderSelectorLabel} numberOfLines={1}>
                {currentProject.displayName}
              </Text>
              <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" width={240}>
              {projects.map((entry) => (
                <ProjectSelectorItem key={`${entry.serverId}:${entry.projectId}`} entry={entry} />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      }
      right={right}
    />
  );
}

// Gear in the tasks headers (desktop + compact) → the project's configuration sheet.
function ProjectSettingsButton({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    router.navigate(buildProjectSettingsRoute(projectId));
  }, [projectId]);
  return (
    <Pressable
      onPress={handlePress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={t("sidebar.project.actions.openSettings")}
      testID="tasks-header-project-settings"
      style={styles.headerSettingsButton}
    >
      <ThemedSettings size={ICON_SIZE.md} uniProps={mutedColorMapping} />
    </Pressable>
  );
}

function CompactProjectPicker({ projects }: { projects: ProjectEntry[] }) {
  const { t } = useTranslation();
  const tones = useProjectToneMap(projects);
  return (
    <ScrollView contentContainerStyle={styles.listContent}>
      <Text style={styles.sectionLabel}>{t("tasks.pickProject")}</Text>
      {projects.length === 0 ? <Text style={styles.emptyText}>{t("tasks.noProjects")}</Text> : null}
      {projects.map((entry) => (
        <CompactProjectRow
          key={`${entry.serverId}:${entry.projectId}`}
          entry={entry}
          tone={tones.get(`${entry.serverId}:${entry.projectId}`) ?? null}
        />
      ))}
    </ScrollView>
  );
}

const CompactProjectRow = memo(function CompactProjectRow({
  entry,
  tone,
}: {
  entry: ProjectEntry;
  tone: TaskTone | null;
}) {
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
      <TaskStatusVoyant tone={tone} />
      <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
    </Pressable>
  );
});

function CompactFolderList({
  boardHandle,
  supportsAutopilot,
}: {
  boardHandle: BoardHandle;
  supportsAutopilot: boolean;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const footerStyle = useMemo(
    () => [styles.stickyFooter, { paddingBottom: insets.bottom + FOOTER_VERTICAL_PADDING }],
    [insets.bottom],
  );
  const folderModal = useFolderModal(boardHandle, supportsAutopilot);
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
  const folderTones = useFolderToneMap(boardHandle.board?.tasks ?? EMPTY_TASKS);

  return (
    <View style={styles.compactListWrap}>
      <ScrollView contentContainerStyle={styles.listContent}>
        <Text style={styles.sectionLabel}>{t("tasks.folders")}</Text>
        {folders.map((folder) => (
          <CompactFolderRow
            key={folder.id}
            folder={folder}
            taskCount={taskCounts.get(folder.id) ?? 0}
            tone={folderTones.get(folder.id) ?? null}
            onEditFolder={folderModal.openEdit}
            onDeleteFolder={boardHandle.deleteFolder}
          />
        ))}
        {folders.length === 0 && !boardHandle.isLoading ? (
          <Text style={styles.emptyText}>{t("tasks.noFolders")}</Text>
        ) : null}
      </ScrollView>
      <View style={footerStyle}>
        <Button
          leftIcon={Plus}
          variant="secondary"
          size="sm"
          onPress={folderModal.openCreate}
          style={styles.footerButton}
          testID="tasks-new-folder-open"
        >
          {t("tasks.actions.addFolder")}
        </Button>
      </View>
      {folderModal.element}
    </View>
  );
}

const CompactFolderRow = memo(function CompactFolderRow({
  folder,
  taskCount,
  tone,
  onEditFolder,
  onDeleteFolder,
}: {
  folder: TaskFolder;
  taskCount: number;
  tone: TaskTone | null;
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
      <TaskStatusVoyant tone={tone} />
      {folder.autopilot ? <AutopilotMark /> : null}
      <FolderKebabMenu folderId={folder.id} onEdit={handleEdit} onDelete={handleDelete} />
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  // Top-right header cluster: deploy rocket + project gear side by side.
  headerRightCluster: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  // Floating toggle anchored bottom-center of the full tasks area. The wrapper
  // holds the absolute position so the Animated.View can handle scale/opacity
  // without conflicting with the positioning props.
  conductorToggleWrapper: {
    position: "absolute",
    bottom: theme.spacing[4],
    alignSelf: "center",
  },
  conductorToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  conductorToggleLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  // --- Desktop three-pane layout ---
  desktopRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "stretch",
  },
  rail: {
    width: 264,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  railHeader: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[4],
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
  // White, bordered wrapper so the field reads as an input against the grey
  // sidebar rail. flex:1 here (a plain View) reliably fills the row — the
  // FormTextInput's own flex/background is dropped by its style split, exactly
  // like the column toolbar's search field.
  railSearchField: {
    flex: 1,
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    overflow: "hidden",
  },
  // Auto-width icon button: the field flexes to fill the row, this button hugs
  // its icon (horizontal padding instead of a fixed width) and sits beside it.
  sortButton: {
    height: 34,
    paddingHorizontal: theme.spacing[2],
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  sortButtonHovered: {
    backgroundColor: theme.colors.surface1,
  },
  railScroll: {
    flex: 1,
  },
  railContent: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[1],
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
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  // Selected state follows the desktop list+detail pattern (docs/design.md
  // §11): surfaceSidebarHover background, hierarchy via color — not weight.
  railItemSelected: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  railItemBody: {
    flex: 1,
    gap: theme.spacing[1],
  },
  railItemTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  railItemTitleSelected: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  railItemSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  railItemBranch: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
  railItemAction: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  headerSettingsButton: {
    padding: theme.spacing[1],
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
  // No top padding here: the split row (divider + agent panel) must reach the
  // very top. The board's own breathing room lives on boardContainer instead.
  boardArea: {
    flex: 1,
  },
  boardContainer: {
    flex: 1,
    gap: theme.spacing[3],
    paddingTop: theme.spacing[4],
  },
  // Compact keeps a single, even rhythm around the tab switch: the same 12px
  // sits above it (paddingTop) and below it (the container gap to the board),
  // so the tabs read as a balanced band under the header — not glued to it,
  // not floating in a big empty gap.
  boardContainerCompact: {
    flex: 1,
    gap: theme.spacing[3],
    paddingTop: theme.spacing[3],
  },
  // Compact board/timeline tab switch — full width, aligned to the board inset
  // (12) with breathing room below the header so it isn't glued to it.
  compactViewSwitch: {
    paddingHorizontal: theme.spacing[3],
  },
  ganttBoardAlign: {
    marginHorizontal: theme.spacing[4],
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
    fontWeight: theme.fontWeight.medium,
    marginBottom: theme.spacing[1],
  },
  rowItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  rowItemHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowText: {
    flex: 1,
    gap: theme.spacing[1],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
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
  // Mobile board header: back chevron + folder-name dropdown selector.
  boardHeaderLeft: {
    gap: theme.spacing[1],
  },
  boardHeaderBack: {
    padding: theme.spacing[1],
  },
  folderSelector: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
  },
  folderSelectorLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  headerSeparator: {
    fontSize: theme.fontSize.base,
    color: theme.colors.mutedForeground,
  },
  boardHeaderScrollWrap: {
    flex: 1,
    minWidth: 0,
    position: "relative",
  },
  boardHeaderScroll: {
    flexGrow: 0,
  },
  boardHeaderScrollContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  headerScrollFadeRight: {
    position: "absolute",
    top: 0,
    bottom: 0,
    right: 0,
    width: theme.spacing[8],
  },
  headerScrollFadeLeft: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: theme.spacing[8],
  },
  // Folder list: scroll area flexes, footer stays pinned to the bottom edge.
  compactListWrap: {
    flex: 1,
  },
  stickyFooter: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
  },
  footerButton: {
    alignSelf: "stretch",
  },
  // Add-folder action button: full-width across the rail footer so it reads as a
  // clear primary action anchoring the bottom of the folders list.
  addButton: {
    alignSelf: "stretch",
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

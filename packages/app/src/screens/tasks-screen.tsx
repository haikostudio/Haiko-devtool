import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import {
  ArrowDownAZ,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  FolderTree,
  LayoutGrid,
  MoreVertical,
  Paperclip,
  Settings2,
  Wand2,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useShallow } from "zustand/shallow";
import { MenuHeader, SidebarMenuToggle } from "@/components/headers/menu-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { NotificationHistoryButton } from "@/components/notification-history-button";
import { FormTextInput } from "@/components/ui/form-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { countPendingPublish } from "@/components/tasks/pending-publish-count";
import { DeployRestartChain } from "@/components/tasks/deploy-restart-chain";
import { DeployLogSheet } from "@/components/tasks/deploy-log-sheet";
import { useDaemonRestartAction } from "@/components/tasks/use-daemon-restart";
import { useDaemonRestartStore } from "@/stores/daemon-restart-store";
import { showAppDialog } from "@/stores/app-dialog-store";
import { KanbanBoard } from "@/components/tasks/kanban-board";
import {
  type QuotaMenuModel,
  QuotaRingIndicator,
  TaskQuotaMenuButton,
  TaskQuotaSheet,
  useQuotaMenuModel,
} from "@/components/tasks/task-quota-menu";
import { TaskTimelineArea } from "@/components/tasks/task-timeline-area";
import { NewTaskCard } from "@/components/tasks/new-task-card";
import { NewNoteCard, type NewNoteInput } from "@/components/tasks/new-note-card";
import {
  deadlineTagFor,
  PRIORITY_TAG_BY_LEVEL,
  serializeTaskTags,
} from "@/components/tasks/task-tags";
import {
  AgentBucketProvider,
  type LiveProjectBoard,
  TaskStatusVoyant,
  useProjectBoardTasks,
  useProjectToneMap,
} from "@/components/tasks/task-status-voyant";
import type { TaskTone } from "@/components/tasks/task-status-tone";
import { logRefusedMove } from "@/components/tasks/board-move-log";
import { RefusedMovesNotice } from "@/components/tasks/refused-moves-notice";
import { StaleEngineBanner } from "@/components/tasks/stale-engine-banner";
import { useDaemonBuildFreshness } from "@/components/tasks/use-daemon-build-freshness";
import { isTaskMoveAllowed } from "@/components/tasks/task-move-guard";
import { type TaskDetailSaveInput } from "@/components/tasks/task-detail-sheet";
import { TaskDetailDrawer } from "@/components/tasks/task-detail-drawer";
import { ConductorPanel, type ConductorPanelProps } from "@/components/tasks/conductor-panel";
import { ConductorSidePanel } from "@/components/tasks/conductor-side-panel";
import { TaskExplorerDock } from "@/components/tasks/task-explorer-dock";
import { TaskExplorerSidePanel } from "@/components/tasks/task-explorer-side-panel";
import { TaskFilePreviewPanel } from "@/components/tasks/task-file-preview-panel";
import { TaskAttachmentsSidePanel } from "@/components/tasks/task-attachments-side-panel";
import { DEFAULT_TASKS_QUIET_HOURS } from "@/components/tasks/task-schedule";
import { TaskScheduleProvider } from "@/components/tasks/task-schedule-context";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useToast } from "@/contexts/toast-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { useTaskBoard, type KanbanTask, type TaskBoard, type TaskColumn } from "@/data/tasks";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useTaskBoardToastNavStore } from "@/stores/task-board-toast-nav-store";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { deriveProjectIconColor } from "@/utils/project-icon-color";
import { buildProjectSettingsRoute } from "@/utils/host-routes";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedClock = withUnistyles(Clock);
const ThemedSortAz = withUnistyles(ArrowDownAZ);
const ThemedFolderTree = withUnistyles(FolderTree);
const ThemedSettings = withUnistyles(Settings2);
const ThemedMoreVertical = withUnistyles(MoreVertical);
const ThemedPaperclip = withUnistyles(Paperclip);
const ThemedWand = withUnistyles(Wand2);
const ENGINE_UPDATE_POLL_MS = 2_000;
const ENGINE_UPDATE_TIMEOUT_MS = 30 * 60 * 1_000;

class EngineUpdateFailure extends Error {}

function engineUpdatePhaseKey(
  phase: string | null | undefined,
):
  | "tasks.board.batchPhase.start"
  | "tasks.board.batchPhase.save"
  | "tasks.board.batchPhase.build"
  | "tasks.board.batchPhase.publish" {
  if (phase === "save") return "tasks.board.batchPhase.save";
  if (phase === "build") return "tasks.board.batchPhase.build";
  if (phase === "publish") return "tasks.board.batchPhase.publish";
  return "tasks.board.batchPhase.start";
}

function waitForEngineUpdatePoll(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ENGINE_UPDATE_POLL_MS));
}

// Stable empty-array identity so the tone hooks' memos don't rebuild every
// render while a board is still loading (a fresh `[]` would look like new input).
type ProjectSortMode = "recent" | "name";

interface ProjectEntry {
  serverId: string;
  hostLabel: string;
  projectId: string;
  displayName: string;
  rootPath: string;
  /**
   * A representative workspace id for the project, used to scope the attachment
   * library (which the daemon keys per-workspace). Prefers the primary checkout
   * over any legacy worktree. Empty when the project has no live workspace.
   */
  workspaceId: string;
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

// Pick one representative workspace per project to scope the attachment library.
// The daemon keys the library per-workspace, so the board — which is
// project-level — points at the primary checkout rather than a throwaway
// legacy worktree. First non-worktree wins; otherwise the first seen.
function pickRepresentativeWorkspaces(
  workspaces: Iterable<WorkspaceDescriptor>,
): Map<string, string> {
  const chosen = new Map<string, string>();
  const chosenIsWorktree = new Map<string, boolean>();
  for (const workspace of workspaces) {
    const isWorktree = workspace.workspaceKind === "worktree";
    const have = chosen.has(workspace.projectId);
    const upgrade = have && !isWorktree && chosenIsWorktree.get(workspace.projectId) === true;
    if (!have || upgrade) {
      chosen.set(workspace.projectId, workspace.id);
      chosenIsWorktree.set(workspace.projectId, isWorktree);
    }
  }
  return chosen;
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
      const representativeWorkspace = pickRepresentativeWorkspaces(session.workspaces.values());
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
          workspaceId: representativeWorkspace.get(workspace.projectId) ?? workspace.id,
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
          workspaceId: "",
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
  tasks: number;
}

// The "Y tâche(s)" subtitle, read off the boards the rail already subscribes to.
// It used to re-fetch every project's board itself, doubling a sweep the voyant
// hook was already doing.
function projectTaskCounts(tasksByProject: Map<string, KanbanTask[]>): Map<string, ProjectCounts> {
  const counts = new Map<string, ProjectCounts>();
  for (const [key, tasks] of tasksByProject) {
    counts.set(key, { tasks: tasks.length });
  }
  return counts;
}

// Compact only: true once the user has deliberately walked BACK to the projects
// list. The auto-selection below then stands down, so tapping "back" no longer
// bounces straight into the board it just left. Any explicit pick clears the
// flag, and so does leaving the screen.
let compactSelectionCleared = false;

export function __resetCompactSelectionCleared(): void {
  compactSelectionCleared = false;
}

function selectProject(entry: ProjectEntry): void {
  compactSelectionCleared = false;
  // `folder: undefined` scrubs the legacy folder param off bookmarked/restored
  // URLs — folders are gone from the product and nothing reads it any more.
  router.setParams({ host: entry.serverId, project: entry.projectId, folder: undefined });
}

// A project has exactly one task list now. Its id is only the bucket new cards
// are filed under (the server mints one on demand); the board itself never
// narrows by it.
function boardListId(board: TaskBoard | null): string {
  return board?.folders[0]?.id ?? "";
}

function tasksHeaderTitle(
  t: ReturnType<typeof useTranslation>["t"],
  isCompact: boolean,
  selectedProject: ProjectEntry | null,
): string {
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
  const params = useLocalSearchParams<{ host?: string; project?: string }>();
  const serverId = typeof params.host === "string" && params.host ? params.host : null;
  const projectId = typeof params.project === "string" && params.project ? params.project : null;

  const projects = useProjectEntries();
  const supportsTasksBoard = useHostFeature(serverId, "tasksBoard");
  const boardHandle = useTaskBoard(serverId, projectId);

  const selectedProject = useMemo(
    () =>
      projects.find((entry) => entry.serverId === serverId && entry.projectId === projectId) ??
      null,
    [projects, serverId, projectId],
  );
  // One-page layout: keep a project selected at all times so the panes are
  // always populated. There is no second level any more — a project opens
  // straight onto its single board.
  const firstProject = projects[0] ?? null;
  useEffect(() => {
    // Mobile behaves like desktop: land straight on the board instead of an
    // empty picker. The one exception is a deliberate "back" — see
    // compactSelectionCleared — otherwise the back button would bounce the user
    // right back into the board they just left.
    if (isCompact && compactSelectionCleared) {
      return;
    }
    if (!projectId && firstProject) {
      selectProject(firstProject);
    }
  }, [isCompact, projectId, firstProject]);

  // Leaving the board forgets the "user walked back" intent, so the next visit
  // opens on the board again.
  useEffect(() => () => __resetCompactSelectionCleared(), []);

  // Task selection (which chat the dock shows, which drawer is open) is per
  // project; drop it whenever the project changes so a stale chat/drawer never
  // lingers from another project. These store fields are ephemeral (not persisted).
  const setDockTaskId = useTasksBoardUiStore((state) => state.setDockTaskId);
  const setDockDeployAgentId = useTasksBoardUiStore((state) => state.setDockDeployAgentId);
  const setDetailsTaskId = useTasksBoardUiStore((state) => state.setDetailsTaskId);
  const setConductorOpen = useTasksBoardUiStore((state) => state.setConductorOpen);
  useEffect(() => {
    setDockTaskId(null);
    setDockDeployAgentId(null);
    setDetailsTaskId(null);
  }, [serverId, projectId, setDockTaskId, setDockDeployAgentId, setDetailsTaskId]);

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

  const title = tasksHeaderTitle(t, isCompact, selectedProject);

  return (
    <AgentBucketProvider>
      <View style={styles.container}>
        {/* Renders nothing: fires the restart the user chained to a
            publication, once that card's work is actually live. */}
        <DeployRestartChain serverId={serverId} tasks={boardHandle.board?.tasks ?? EMPTY_TASKS} />
        <TasksHeader
          title={title}
          isCompact={isCompact}
          supportsTasksBoard={supportsTasksBoard}
          selectedProject={selectedProject}
          projects={projects}
        />
        {isCompact ? (
          <CompactFlow
            serverId={serverId}
            projectId={projectId}
            projects={projects}
            supportsTasksBoard={supportsTasksBoard}
            boardHandle={boardHandle}
          />
        ) : (
          <DesktopLayout
            serverId={serverId}
            projectId={projectId}
            projects={projects}
            selectedProject={selectedProject}
            supportsTasksBoard={supportsTasksBoard}
            boardHandle={boardHandle}
          />
        )}
        {/* Compact keeps the floating bottom dock — a side panel would leave
            neither the board nor the tree wide enough to use on a phone. */}
        {isCompact ? (
          <>
            <TaskExplorerDock
              serverId={serverId}
              workspaceId={selectedProject?.workspaceId || null}
              projectRootPath={selectedProject?.rootPath ?? null}
            />
            {/* Compact preview is a full-height sheet over the dock — half a
                phone width would be unreadable. Desktop mounts its overlay
                inside the board area instead. */}
            <TaskFilePreviewPanel
              serverId={serverId}
              projectRootPath={selectedProject?.rootPath ?? null}
            />
            {/* Same story for the attachments library: a full-height sheet on a
                phone, the right-hand slide-over on desktop. */}
            <TaskAttachmentsSidePanel
              serverId={serverId}
              workspaceId={selectedProject?.workspaceId || null}
            />
          </>
        ) : null}
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
// Desktop: one-page two-pane layout — projects rail | board.
// ---------------------------------------------------------------------------

function DesktopLayout({
  serverId,
  projectId,
  projects,
  selectedProject,
  supportsTasksBoard,
  boardHandle,
}: {
  serverId: string | null;
  projectId: string | null;
  projects: ProjectEntry[];
  selectedProject: ProjectEntry | null;
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
  } else {
    // Folders are gone: the board opens straight away and shows every task of
    // the project.
    boardArea = (
      <BoardContent
        key={`${serverId}:${projectId}`}
        serverId={serverId}
        projectId={projectId}
        listId={boardListId(boardHandle.board)}
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
      {/* The board area doubles as the preview overlay's stage: the panel floats
          over the timeline and the columns without resizing either, while the
          explorer tree beside it stays visible to pick the next file. */}
      <View style={styles.boardArea}>
        {boardArea}
        <TaskFilePreviewPanel
          serverId={serverId}
          projectRootPath={selectedProject?.rootPath ?? null}
        />
        {/* The attachments library shares that stage — and the same slide-over
            width — so the paperclip opens where a file preview would. */}
        <TaskAttachmentsSidePanel
          serverId={serverId}
          workspaceId={selectedProject?.workspaceId || null}
        />
      </View>
      {/* The explorer is a sibling of the board, not an overlay: it takes its
          width out of the row so the columns stay fully readable beside it. */}
      <TaskExplorerSidePanel
        serverId={serverId}
        workspaceId={selectedProject?.workspaceId || null}
        projectRootPath={selectedProject?.rootPath ?? null}
      />
      {/* The conductor/agents chat is a sibling of the board too — same concept as
          the explorer: it splits the row rather than floating over the board. */}
      <ConductorSidePanelHost serverId={serverId} projectId={projectId} boardHandle={boardHandle} />
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
  // One live subscription per project: every dot in the rail reacts the moment
  // its project's board changes, and both the tone and the count read from it.
  const tasksByProject = useProjectBoardTasks(projects);
  const counts = useMemo(() => projectTaskCounts(tasksByProject), [tasksByProject]);
  // The viewed project's board additionally carries the optimistic overlay of a
  // move still in flight, which no push knows about yet.
  const liveBoard = useMemo<LiveProjectBoard | null>(
    () =>
      serverId && projectId && boardHandle.board
        ? { key: `${serverId}:${projectId}`, tasks: boardHandle.board.tasks }
        : null,
    [serverId, projectId, boardHandle.board],
  );
  const tones = useProjectToneMap(tasksByProject, liveBoard);

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
        {counts && counts.tasks > 0 ? (
          <Text style={styles.railItemSubtitle} numberOfLines={1}>
            {t("tasks.taskCount", { count: counts.tasks })}
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

// Colored dot that mirrors the project's icon color elsewhere in the app, so a
// glance ties each rail row (and the Gantt bars) back to the same project.
const ProjectColorMark = memo(function ProjectColorMark({ projectKey }: { projectKey: string }) {
  const dotStyle = useMemo(
    () => [styles.projectColorDot, { backgroundColor: deriveProjectIconColor(projectKey) }],
    [projectKey],
  );
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
  listId,
  boardHandle,
}: {
  serverId: string | null;
  projectId: string | null;
  // Bucket new cards are filed under — see boardListId. Never a filter.
  listId: string;
  boardHandle: BoardHandle;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const { config, patchConfig } = useDaemonConfig(serverId);
  const quietHours = config?.tasks?.quietHours ?? DEFAULT_TASKS_QUIET_HOURS;
  const offPeakEnabled = config?.tasks?.autoDeployOffPeak === true;

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
  const [engineUpdateProgress, setEngineUpdateProgress] = useState<string | null>(null);
  // The publication's log, opened from the progress banner.
  const [deployLogOpen, setDeployLogOpen] = useState(false);

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

  // Every task of the project, for the glanceable billable total and the
  // pending-publish summary: one project, one board, one set of totals.
  const projectTasks = boardHandle.board?.tasks ?? EMPTY_TASKS;

  // Dropping a card into another column is the SAME gesture as pressing that
  // card's action button for the transition — so it must run the SAME handler,
  // not a raw column flip. A raw flip skips the confirmations, the agent
  // dispatch and the deploy-queue side effects, which is exactly what left
  // statuses and the "À déployer" counters out of sync. We reuse the very
  // buttons' handlers (approve / run / validate / deploy) so drag and click can
  // never drift. Transitions with no button equivalent (reorders, backward
  // moves, note → backlog) keep the plain move.
  const taskActions = useBoardTaskActions(boardHandle);
  const handleMoveTask = useCallback(
    (input: { taskId: string; column: TaskColumn; index: number }) => {
      const task = projectTasks.find((entry) => entry.id === input.taskId);
      const from = task?.column;
      const to = input.column;
      // "Désarchiver": the one deliberate way out of the terminal "Archivé"
      // column. The board never lets a card be dragged out (kanban-board.web
      // blocks it, the guard freezes it), so the only move that reaches here from
      // "archived" is the explicit menu action — let it through untouched.
      if (from === "archived" && to !== "archived") {
        void boardHandle.moveTask(input);
        return;
      }
      // Work in flight never walks backward. A card whose agent is executing (or
      // whose final check / publication is running) offers no backward button,
      // so no gesture may take it backward either — the move is dropped in
      // silence and the card stays where it is. This is the choke point every
      // manual path goes through (drag, "Déplacer vers…", chevrons).
      if (task && !isTaskMoveAllowed(task, to)) {
        logRefusedMove(task, to, "board");
        return;
      }
      if (from && from !== to) {
        if (from === "backlog" && to === "validated") {
          taskActions.handleApproveTask(input.taskId);
          return;
        }
        if (from === "scheduled" && to === "in_progress") {
          taskActions.handleRunNow(input.taskId);
          return;
        }
        if (from === "in_progress" && to === "done") {
          taskActions.handleValidate(input.taskId);
          return;
        }
        if (from === "done" && to === "deployed") {
          // Dragging a finished card into "À déployer" QUEUES it — the same effect
          // as its "Mettre dans À déployer" button. It must not publish: entering
          // the queue never marks a card live (that stays the batch's job). This is
          // the queue button, not the per-card deploy button, so the drag=button
          // rule maps to the gesture the card actually offers in that column.
          taskActions.handleQueueDeploy(input.taskId);
          return;
        }
      }
      void boardHandle.moveTask(input);
    },
    [boardHandle, projectTasks, taskActions],
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
      // Sending the prompt IS launching the task: spawn its dedicated agent now
      // (launch: true) instead of leaving an inert draft. The card stays in its
      // column and fills in live as the agent analyzes; opening it shows the
      // agent's chat.
      void boardHandle.createTask({
        folderId: listId,
        title,
        description: text,
        ...(attachments.length > 0 ? { attachments } : {}),
        column: targetColumn,
        launch: true,
      });
    },
    [newTaskColumn, listId, boardHandle],
  );

  // A note is a task in the "notes" column with priority + deadline tags and no
  // estimate/agent. We reuse the same tag helpers a normal task edit writes, so
  // the note renders on the standard card and, once dragged to "backlog", enters
  // the usual cycle with its metadata intact. Passing no `launch`/pipeline column
  // means the server never arms the scheduler for it.
  const handleCreateNote = useCallback(
    ({ text, importance, deadline }: NewNoteInput) => {
      setNewTaskColumn(null);
      const title = deriveTaskTitle(text);
      if (!title) {
        return;
      }
      const tags = serializeTaskTags({
        priorityTag: PRIORITY_TAG_BY_LEVEL[importance],
        deadlineTag: deadline ? deadlineTagFor(deadline) : null,
        tags: [],
      });
      void boardHandle.createTask({
        folderId: listId,
        title,
        // Keep the full note as the description only when it says more than the
        // one-line title, so a short note doesn't render its text twice.
        ...(text.trim() !== title ? { description: text } : {}),
        column: "notes",
        tags,
      });
    },
    [listId, boardHandle],
  );

  const columnExtras = useMemo(() => {
    if (!newTaskColumn || !serverId) {
      return null;
    }
    // The Notes column gets the lightweight note composer; every other column
    // that accepts inline adds (the backlog) gets the standard task composer.
    const node =
      newTaskColumn === "notes" ? (
        <NewNoteCard onSubmit={handleCreateNote} onCancel={handleCancelNewTask} />
      ) : (
        <NewTaskCard
          serverId={serverId}
          cwd=""
          draftKey={`tasks-new:${projectId ?? listId}:${newTaskColumn}`}
          onSubmit={handleCreateTask}
          onCancel={handleCancelNewTask}
        />
      );
    return { column: newTaskColumn, node };
  }, [
    newTaskColumn,
    serverId,
    projectId,
    listId,
    handleCreateTask,
    handleCreateNote,
    handleCancelNewTask,
  ]);

  const handleEstimateTask = useCallback(
    (taskId: string) => {
      toast.show(t("tasks.toast.reanalyzing"));
      // retryTaskAnalysis, not estimateTask: it also clears a recorded analysis
      // failure. Without that, a card whose automatic attempts are spent would
      // ignore the request — "Analyser à nouveau" has to be the way out.
      boardHandle.retryTaskAnalysis(taskId).catch((error) => {
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

  // "Tout déployer": the single publishing gesture. It always confirms first,
  // because the run ends by restarting the engine — every running agent stops
  // with it, so this is never something that happens on a stray tap. Returns
  // whether the run actually started, so the button's optimistic morph can fall
  // back to the button on a cancelled confirmation or a refused run.
  const handleDeployAll = useCallback(async (): Promise<boolean> => {
    const pending = countPendingPublish(projectTasks).pending;
    const confirmed = await confirmDialog({
      title: t("tasks.board.deployAllTitle"),
      message: t("tasks.board.deployAllMessage", { count: pending }),
      confirmLabel: t("tasks.board.deployAllConfirm"),
      cancelLabel: t("common.actions.cancel"),
    });
    if (!confirmed) {
      return false;
    }
    try {
      const { started } = await boardHandle.deployAllTasks();
      toast.show(t("tasks.board.deployAllStarted"));
      return started;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  }, [boardHandle, projectTasks, toast, t]);

  // "Réinitialiser / Relancer le déploiement": the escape hatch on a failed
  // publication banner. It clears the stuck/false-failed state (in-memory run,
  // error, residual lock) and starts a clean run — same engine-restarting gesture
  // as "Tout déployer", so it confirms first. The user stays the one who fires it.
  const handleResetDeploy = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("tasks.board.deployResetTitle"),
        message: t("tasks.board.deployResetMessage"),
        confirmLabel: t("tasks.board.deployResetConfirm"),
        cancelLabel: t("common.actions.cancel"),
      });
      if (!confirmed) {
        return;
      }
      try {
        await boardHandle.deployAllTasks({ reset: true });
        toast.show(t("tasks.board.deployResetStarted"));
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [boardHandle, toast, t]);

  // Tapping the "À déployer" progress banner opens the publication's own log.
  // The publication is a build script — there is no conversation to open, and
  // its output is the only honest account of what the run is doing (which phase,
  // which command refused, why nothing went online).
  const handleOpenDeployLog = useCallback(() => {
    setDeployLogOpen(true);
  }, []);
  const handleCloseDeployLog = useCallback(() => {
    setDeployLogOpen(false);
  }, []);

  // "Retirer du prochain lot" / "Remettre dans le lot": the card keeps its place
  // in "À déployer" and stays visible — the batch simply skips it. A pause, not
  // an archive, so putting it back is the same single gesture.
  const handleToggleDeployHold = useCallback(
    (taskId: string, hold: boolean) => {
      void (async () => {
        try {
          await boardHandle.updateTask({ taskId, deployHold: hold });
          toast.show(t(hold ? "tasks.toast.deployHeld" : "tasks.toast.deployUnheld"));
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      })();
    },
    [boardHandle, toast, t],
  );

  // "Publier automatiquement en heures creuses": one switch on the daemon, since
  // the batch it fires ends by restarting that same daemon. Turning it ON is the
  // standing authorization — the confirmation says so.
  const handleToggleOffPeak = useCallback(
    (next: boolean) => {
      void (async () => {
        if (next) {
          const confirmed = await confirmDialog({
            title: t("tasks.board.deployOffPeak"),
            message: t("tasks.board.deployOffPeakMessage"),
            confirmLabel: t("common.actions.confirm"),
            cancelLabel: t("common.actions.cancel"),
          });
          if (!confirmed) {
            return;
          }
        }
        try {
          await patchConfig({ tasks: { ...config?.tasks, autoDeployOffPeak: next } });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      })();
    },
    [patchConfig, config, toast, t],
  );

  const deployOffPeak = useMemo(
    () => ({ enabled: offPeakEnabled, onToggle: handleToggleOffPeak }),
    [offPeakEnabled, handleToggleOffPeak],
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

  // Does the running engine match what is published? Null unless they diverge.
  const staleEngine = useDaemonBuildFreshness(serverId);
  useEffect(() => {
    if (!staleEngine) setEngineUpdateProgress(null);
  }, [staleEngine]);
  const daemonClient = useHostRuntimeClient(serverId ?? "");
  const busyAgentCount = useSessionStore((state) => {
    const agents = serverId ? state.sessions[serverId]?.agents : undefined;
    if (!agents) return 0;
    let count = 0;
    for (const agent of agents.values()) {
      if (agent.status === "running") count += 1;
    }
    return count;
  });
  // "Arrêter la publication": interrupt the running build. The daemon signals
  // the build script's process group, frees the residual lock and marks the run
  // failed; the batch watcher's next poll settles the cards to "interrompue".
  const handleStopDeploy = useCallback(() => {
    if (!daemonClient) {
      toast.error(t("tasks.board.deployStopFailed"));
      return;
    }
    void (async () => {
      const confirmed = await confirmDialog({
        title: t("tasks.board.deployStopTitle"),
        message: t("tasks.board.deployStopMessage"),
        confirmLabel: t("tasks.board.deployStopConfirm"),
        cancelLabel: t("common.actions.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      try {
        const result = await daemonClient.paseoDeployStop();
        toast.show(
          t(result.stopped ? "tasks.board.deployStopStarted" : "tasks.board.deployStopIdle"),
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [daemonClient, toast, t]);

  const handleUpdateStaleEngine = useCallback(() => {
    if (!daemonClient || engineUpdateProgress !== null) {
      if (!daemonClient) toast.error(t("tasks.board.staleEngineFailed"));
      return;
    }
    void (async () => {
      if (busyAgentCount > 0) {
        const confirmed = await confirmDialog({
          title: t("tasks.board.staleEngineTitle"),
          message: t("tasks.panel.restartDaemonBusyMessage", { count: busyAgentCount }),
          confirmLabel: t("tasks.board.staleEngineAction"),
          cancelLabel: t("common.actions.cancel"),
          destructive: true,
        });
        if (!confirmed) return;
      }

      setEngineUpdateProgress(t("tasks.board.batchPhase.start"));
      try {
        const result = await daemonClient.paseoDeployTrigger({
          projectId: projectId ?? undefined,
        });
        if (!result.started) {
          throw new Error(result.error ?? "Engine update did not start");
        }
        toast.show(t("tasks.board.staleEngineStarted"));

        const deadline = Date.now() + ENGINE_UPDATE_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await waitForEngineUpdatePoll();
          try {
            const status = await daemonClient.paseoDeployStatus();
            if (status.deployOutcome === "failed" || status.deployPhase === "error") {
              throw new EngineUpdateFailure(status.lastError ?? "Engine update failed");
            }
            if (
              status.daemonBuiltSha &&
              status.deployedSha &&
              status.daemonBuiltSha === status.deployedSha
            ) {
              setEngineUpdateProgress(t("tasks.board.batchPhase.done"));
              return;
            }
            if (status.deploying) {
              setEngineUpdateProgress(t(engineUpdatePhaseKey(status.deployPhase)));
            } else {
              setEngineUpdateProgress(t("tasks.panel.restartDaemonReconnecting"));
            }
          } catch (error) {
            if (error instanceof EngineUpdateFailure) {
              throw error;
            }
            setEngineUpdateProgress(t("tasks.panel.restartDaemonReconnecting"));
          }
        }
        throw new Error("Engine update timed out");
      } catch {
        setEngineUpdateProgress(null);
        toast.error(t("tasks.board.staleEngineFailed"));
      }
    })();
  }, [busyAgentCount, daemonClient, engineUpdateProgress, projectId, t, toast]);

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
      {/* The engine running an older build than what is online is invisible by
          definition — everything looks published. Said here, above the work it
          silently affects. */}
      <StaleEngineBanner
        freshness={staleEngine}
        onUpdate={handleUpdateStaleEngine}
        progressLabel={engineUpdateProgress}
      />
      {/* Gestures the board refused, which are silent by design and therefore
          indistinguishable from a broken board when they repeat. */}
      <RefusedMovesNotice />
      {showTimeline ? (
        <TaskTimelineArea
          board={boardHandle.board}
          onPressTask={handlePressTask}
          fill={isCompact}
        />
      ) : null}
      {showBoard ? (
        <KanbanBoard
          board={boardHandle.board}
          onMoveTask={handleMoveTask}
          onPressTask={handlePressTask}
          onAddTask={setNewTaskColumn}
          onRunTask={handleRunTaskNow}
          onReanalyzeTask={handleEstimateTask}
          onDeleteTask={handleDeleteTask}
          onDeployAll={handleDeployAll}
          onOpenDeployLog={handleOpenDeployLog}
          onResetDeploy={handleResetDeploy}
          onStopDeploy={handleStopDeploy}
          onToggleDeployHold={handleToggleDeployHold}
          deployOffPeak={deployOffPeak}
          columnExtras={columnExtras}
        />
      ) : null}
      <DeployLogSheet serverId={serverId} visible={deployLogOpen} onClose={handleCloseDeployLog} />
    </View>
  );

  return <TaskScheduleProvider value={quietHours}>{boardStack}</TaskScheduleProvider>;
}

// Task actions bound to a board handle, shared by the conductor dock (its
// Details tab) and the standalone Details/Billing drawer so the two never drift.
/** Stable empty list, so a board-less screen doesn't remount the watcher's effects. */
const EMPTY_TASKS: KanbanTask[] = [];

type DeployChoice = "cancel" | "deploy" | "deploy_restart";

/**
 * Two doors for an app-only card, three when a restart will be needed. Kept as
 * one call so the deploy handler reads as a single decision.
 */
async function askDeployChoice(
  needsRestart: boolean,
  message: string,
  preferChained: boolean,
  t: (key: string) => string,
): Promise<DeployChoice> {
  if (needsRestart) {
    return confirmDeployWithRestart(message, preferChained, t);
  }
  const confirmed = await confirmDialog({
    title: t("tasks.panel.deployTask"),
    message,
    confirmLabel: t("tasks.panel.deployTask"),
    cancelLabel: t("common.actions.cancel"),
  });
  return confirmed ? "deploy" : "cancel";
}

/**
 * The deploy confirmation for a card that will need a daemon restart: three
 * doors instead of two. "Publier" leaves the restart for later (the card keeps
 * its bar); "Publier puis redémarrer" chains both so the errand is one gesture.
 * Cancelling — including dismissing the sheet — is always the safe default.
 *
 * `preferChained` remembers what the user chose last time and makes it the
 * highlighted (last, primary) action. It only ever reorders: both doors stay on
 * screen, so a remembered habit can never railroad a one-off decision.
 */
async function confirmDeployWithRestart(
  message: string,
  preferChained: boolean,
  t: (key: string) => string,
): Promise<DeployChoice> {
  const deploy = {
    id: "deploy",
    label: t("tasks.panel.deployTask"),
    variant: "secondary" as const,
  };
  const chained = { id: "deploy_restart", label: t("tasks.panel.deployThenRestart") };
  const actionId = await showAppDialog({
    title: t("tasks.panel.deployTask"),
    message: `${message}\n\n${t("tasks.panel.deployThenRestartMessage")}`,
    actions: preferChained
      ? [{ id: "cancel", label: t("common.actions.cancel"), variant: "secondary" }, deploy, chained]
      : [
          { id: "cancel", label: t("common.actions.cancel"), variant: "secondary" },
          { ...chained, variant: "secondary" as const },
          { ...deploy, variant: undefined },
        ],
    dismissActionId: "cancel",
  });
  return actionId === "deploy" || actionId === "deploy_restart" ? actionId : "cancel";
}

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
      // retryTaskAnalysis, not estimateTask: it also clears a recorded analysis
      // failure. Without that, a card whose automatic attempts are spent would
      // ignore the request — "Analyser à nouveau" has to be the way out.
      boardHandle.retryTaskAnalysis(taskId).catch((error) => {
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
  // The backlog card's "Valider la tâche" bar: the user's consent to admit an
  // "À faire" card into the pipeline. Shares the server's generalized approve
  // path with the proposal-approve button, but surfaces a toast since the bar has
  // no other feedback — the card slides to "Validé" and the estimator takes over.
  const handleApproveTask = useCallback(
    (taskId: string) => {
      toast.show(t("tasks.panel.approveDispatched"));
      boardHandle.approveTask(taskId).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [boardHandle, toast, t],
  );
  // The one and only path from "En cours" to "Terminée", and a plain move: the
  // card changes column and nothing else runs. It used to hand a check-then-deploy
  // prompt to the card's own agent, which both burned a full turn per card and put
  // the work online before the user had queued anything. Verification now belongs
  // to the publication (see docs/task-board-cycle.md).
  const handleValidate = useCallback(
    (taskId: string, options?: { queueOnComplete?: boolean }) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("tasks.panel.validateTask"),
          message: t("tasks.panel.validateTaskMessage"),
          confirmLabel: t("tasks.panel.validateTask"),
          cancelLabel: t("common.actions.cancel"),
        });
        if (!confirmed) {
          return;
        }
        try {
          await boardHandle.validateTask(taskId, {
            queueOnComplete: options?.queueOnComplete === true,
          });
          toast.show(t("tasks.panel.validatePassed"));
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      })();
    },
    [boardHandle, toast, t],
  );
  const handleSetHold = useCallback(
    (taskId: string, hold: boolean) => {
      boardHandle.updateTask({ taskId, executionHold: hold }).catch((error) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [boardHandle, toast],
  );
  // "Archiver": hide a finished card from the board. It never publishes or moves
  // the card — publication already ran on its own when the card reached "Terminé".
  const handleArchive = useCallback(
    (taskId: string) => {
      void (async () => {
        const confirmed = await confirmDialog({
          title: t("tasks.panel.archiveTask"),
          message: t("tasks.panel.archiveTaskMessage"),
          confirmLabel: t("tasks.panel.archiveTask"),
          cancelLabel: t("common.actions.cancel"),
        });
        if (!confirmed) {
          return;
        }
        try {
          await boardHandle.archiveTask(taskId);
          toast.show(t("tasks.toast.archived"));
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        }
      })();
    },
    [boardHandle, toast, t],
  );
  // "Lancer le déploiement": the deploy sibling of the final check, offered on a
  // finished ("Terminé") card. Hands the card's OWN agent a deploy-then-confirm
  // prompt, in the card's own conversation: it verifies the work, publishes it and
  // moves the card to "Déployé" itself, reporting whether a daemon restart is
  // needed. The user reads all of it live.
  const setRestartAfterDeploy = useDaemonRestartStore((state) => state.setRestartAfterDeploy);
  const preferChained = useTasksBoardUiStore((state) => state.preferDeployThenRestart);
  const setPreferChained = useTasksBoardUiStore((state) => state.setPreferDeployThenRestart);
  const handleDeploy = useCallback(
    (taskId: string) => {
      void (async () => {
        const task = boardHandle.board?.tasks.find((entry) => entry.id === taskId);
        const alreadyRunning = task?.deployment?.state === "running";
        const message = alreadyRunning
          ? t("tasks.panel.deployRestartMessage")
          : t("tasks.panel.deployTaskMessage");
        // A card that will need a daemon restart gets a third choice, so the
        // whole "publier puis redémarrer" errand is one decision instead of two
        // trips: publish, wait, come back, press restart.
        const needsRestart = task?.needsDaemonRestart === true;
        const choice = await askDeployChoice(needsRestart, message, preferChained, t);
        if (choice === "cancel") {
          return;
        }
        // Armed BEFORE the deploy so a publication that lands fast can never
        // slip past the watcher.
        setRestartAfterDeploy(choice === "deploy_restart" ? taskId : null);
        // Remember the habit, but only when both doors were actually offered.
        if (needsRestart) {
          setPreferChained(choice === "deploy_restart");
        }
        try {
          await boardHandle.deployTask(taskId);
          toast.show(
            choice === "deploy_restart"
              ? t("tasks.panel.deployThenRestartDispatched")
              : t("tasks.panel.deployDispatched"),
          );
        } catch (error) {
          setRestartAfterDeploy(null);
          toast.error(error instanceof Error ? error.message : String(error));
        }
      })();
    },
    [boardHandle, toast, t, setRestartAfterDeploy, preferChained, setPreferChained],
  );
  // "Mettre dans À déployer": the button twin of dragging a finished card into
  // the publication queue. It ONLY moves the column — it never publishes and
  // never marks the card live (that stays the batch's job). Same effect as the
  // drag, so the board's one rule holds: a button does exactly what its drag does.
  const handleQueueDeploy = useCallback(
    (taskId: string) => {
      boardHandle.moveTask({ taskId, column: "deployed", index: 0 }).then(
        () => toast.show(t("tasks.toast.queuedForDeploy")),
        (error) => toast.error(error instanceof Error ? error.message : String(error)),
      );
    },
    [boardHandle, toast, t],
  );
  return {
    handleSave,
    handleDelete,
    handleEstimate,
    handleRunNow,
    handleApprove,
    handleApproveTask,
    handleValidate,
    handleSetHold,
    handleArchive,
    handleDeploy,
    handleQueueDeploy,
  };
}

// Bottom-center floating toggle + the shared chat dock overlay. Gated on the
// host feature flag; rendered at the TasksScreen root so its absolute position
// centers across the full tasks area (including rails), not just the board. The
// dock shows the conductor agent by default and, when a task is tapped on the
// board, that task's Chat / Details / Billing tabs.
// The full set of props both conductor shells need — the dockTask resolved from
// the selection plus every task action. Shared by the compact bottom sheet
// (`ConductorDock`) and the desktop in-row side panel (`ConductorSidePanelHost`)
// so the two surfaces stay in lockstep.
function useConductorPanelProps(
  serverId: string | null,
  projectId: string | null,
  boardHandle: BoardHandle,
): ConductorPanelProps {
  const dockTaskId = useTasksBoardUiStore((state) => state.dockTaskId);
  const setDockTaskId = useTasksBoardUiStore((state) => state.setDockTaskId);
  const dockDeployAgentId = useTasksBoardUiStore((state) => state.dockDeployAgentId);
  const setDockDeployAgentId = useTasksBoardUiStore((state) => state.setDockDeployAgentId);
  const setConductorOpen = useTasksBoardUiStore((state) => state.setConductorOpen);
  const taskActions = useBoardTaskActions(boardHandle);
  // "Redémarrer le moteur", offered on a published card whose work only takes
  // effect after a restart. Lives here (not in useBoardTaskActions) because it
  // acts on the host, not on the board.
  const daemonRestart = useDaemonRestartAction(serverId);
  const handleRestartDaemon = useCallback(() => {
    void daemonRestart.restart();
  }, [daemonRestart]);
  const handleCancelRestartDaemon = daemonRestart.cancel;

  const dockTask = useMemo(
    () =>
      dockTaskId ? (boardHandle.board?.tasks.find((task) => task.id === dockTaskId) ?? null) : null,
    [dockTaskId, boardHandle.board],
  );

  // Closing the panel also drops the task/deploy selection so it never reopens
  // pointed at a task that has since gone away, or at a finished publication.
  const handleClose = useCallback(() => {
    setConductorOpen(false);
    setDockTaskId(null);
    setDockDeployAgentId(null);
  }, [setConductorOpen, setDockTaskId, setDockDeployAgentId]);
  // "Back to conductor" leaves whichever view covered the dock — a task chat or
  // the deploy agent.
  const handleBack = useCallback(() => {
    setDockTaskId(null);
    setDockDeployAgentId(null);
  }, [setDockTaskId, setDockDeployAgentId]);

  return useMemo(
    () => ({
      serverId,
      projectId,
      dockTask,
      dockDeployAgentId,
      onBackToConductor: handleBack,
      onRunNow: taskActions.handleRunNow,
      onSave: taskActions.handleSave,
      onDelete: taskActions.handleDelete,
      onEstimate: taskActions.handleEstimate,
      onApprove: taskActions.handleApprove,
      onApproveTask: taskActions.handleApproveTask,
      onValidate: taskActions.handleValidate,
      onArchive: taskActions.handleArchive,
      onDeploy: taskActions.handleDeploy,
      onQueueDeploy: taskActions.handleQueueDeploy,
      onRestartDaemon: handleRestartDaemon,
      onCancelRestartDaemon: handleCancelRestartDaemon,
      restartProgress: daemonRestart.progress,
      onSetHold: taskActions.handleSetHold,
      onClose: handleClose,
    }),
    [
      serverId,
      projectId,
      dockTask,
      dockDeployAgentId,
      handleBack,
      handleClose,
      taskActions,
      handleRestartDaemon,
      handleCancelRestartDaemon,
      daemonRestart.progress,
    ],
  );
}

// Desktop: the conductor chat as a right-hand side panel that splits the row with
// the board — the same concept as the file explorer's side panel. Rendered inside
// the board row (not at the screen root) so it takes its width out of the row
// instead of floating over it. Mounted only while open so its ensure/bootstrap
// never runs behind a closed panel.
function ConductorSidePanelHost({
  serverId,
  projectId,
  boardHandle,
}: {
  serverId: string | null;
  projectId: string | null;
  boardHandle: BoardHandle;
}) {
  const supportsConductor = useHostFeature(serverId, "tasksConductor");
  const conductorOpen = useTasksBoardUiStore((state) => state.conductorOpen);
  const panelProps = useConductorPanelProps(serverId, projectId, boardHandle);
  if (!supportsConductor || !projectId || !conductorOpen) {
    return null;
  }
  return <ConductorSidePanel {...panelProps} />;
}

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
  const panelProps = useConductorPanelProps(serverId, projectId, boardHandle);
  const handleOpen = useCallback(() => setConductorOpen(true), [setConductorOpen]);

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
    // Desktop renders the conductor as an in-row side panel (ConductorSidePanelHost);
    // at the screen root we only own the compact bottom sheet. Either way the open
    // toggle is hidden while the panel is up.
    return isCompact ? <ConductorPanel {...panelProps} /> : null;
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
// Compact (phone): one drill-down step — projects → board.
// ---------------------------------------------------------------------------

function CompactFlow({
  serverId,
  projectId,
  projects,
  supportsTasksBoard,
  boardHandle,
}: {
  serverId: string | null;
  projectId: string | null;
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
  return (
    <View style={styles.compactBoardWrap}>
      <BoardContent
        serverId={serverId}
        projectId={projectId}
        listId={boardListId(boardHandle.board)}
        boardHandle={boardHandle}
      />
    </View>
  );
}

function clearTasksSelection() {
  compactSelectionCleared = true;
  router.setParams({ host: undefined, project: undefined, folder: undefined });
}

// Picks the right header. On mobile the header owns navigation — it switches
// projects in place; everywhere else it's the plain menu header.
/**
 * True when this project can show an attachments library: the host advertises
 * the `attachmentLibrary` capability and the project has a live workspace to
 * scope the library to.
 */
function useAttachmentsSupported(project: ProjectEntry | null): boolean {
  const supported = useSessionStore((s) =>
    project
      ? s.sessions[project.serverId]?.serverInfo?.features?.attachmentLibrary === true
      : false,
  );
  return Boolean(project && supported && project.workspaceId.length > 0);
}

/**
 * "Pièces jointes" button for the task manager header — sits right beside the
 * quota ring and toggles the project's attachments slide-over, exactly like the
 * explorer button toggles the file tree.
 */
function TasksAttachmentLibraryButton({ project }: { project: ProjectEntry | null }) {
  const supported = useAttachmentsSupported(project);
  const open = useTasksBoardUiStore((state) => state.attachmentsOpen);
  const setOpen = useTasksBoardUiStore((state) => state.setAttachmentsOpen);
  const handleToggle = useCallback(() => setOpen(!open), [open, setOpen]);
  if (!supported) return null;
  return (
    <Pressable
      onPress={handleToggle}
      style={headerIconButtonStyle}
      accessibilityRole="button"
      accessibilityLabel="Pièces jointes du projet"
      testID="attachment-library-button"
    >
      <ThemedPaperclip size={ICON_SIZE.md} uniProps={mutedColorMapping} />
    </Pressable>
  );
}

/**
 * "Explorateur" button for the task manager header: toggles the project's file
 * tree — a resizable right-hand panel on desktop, a bottom dock on compact.
 * Kept next to the attachments button so the whole top-right cluster reads as
 * "things about this project".
 */
function TasksExplorerButton({ project }: { project: ProjectEntry | null }) {
  const { t } = useTranslation();
  const open = useTasksBoardUiStore((state) => state.explorerOpen);
  const setOpen = useTasksBoardUiStore((state) => state.setExplorerOpen);
  const handleToggle = useCallback(() => setOpen(!open), [open, setOpen]);
  if (!project) {
    return null;
  }
  return (
    <Pressable
      onPress={handleToggle}
      style={headerIconButtonStyle}
      accessibilityRole="button"
      accessibilityLabel={t("tasks.explorer.title")}
      testID="tasks-explorer-toggle"
    >
      <ThemedFolderTree size={ICON_SIZE.md} uniProps={mutedColorMapping} />
    </Pressable>
  );
}

function headerIconButtonStyle({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) {
  return [styles.headerIconButton, (hovered || pressed) && styles.headerIconButtonHovered];
}

type HeaderMenuSheet = "quota" | null;

// Static leading icons for the compact header menu — no props, so they are built
// once at module scope instead of memoized in every render pass.
const HEADER_MENU_ICONS = {
  explorer: <ThemedFolderTree size={ICON_SIZE.sm} uniProps={mutedColorMapping} />,
  attachments: <ThemedPaperclip size={ICON_SIZE.sm} uniProps={mutedColorMapping} />,
  settings: <ThemedSettings size={ICON_SIZE.sm} uniProps={mutedColorMapping} />,
} as const;

/**
 * Compact header actions: one "⋮" button instead of the desktop row of icons.
 *
 * A phone header also carries the hamburger, the back chevron and the project
 * selector, so five trailing icons left the project name a couple of characters
 * wide. The menu owns the sheets itself (rather than nesting the
 * desktop buttons, whose drawers would unmount with the menu) and keeps them
 * mounted as siblings, so a sheet survives the menu closing behind it.
 */
function TasksHeaderOverflowMenu({ project }: { project: ProjectEntry | null }) {
  const { t } = useTranslation();
  const [sheet, setSheet] = useState<HeaderMenuSheet>(null);
  const explorerOpen = useTasksBoardUiStore((state) => state.explorerOpen);
  const setExplorerOpen = useTasksBoardUiStore((state) => state.setExplorerOpen);

  const canAttach = useAttachmentsSupported(project);
  const attachmentsOpen = useTasksBoardUiStore((state) => state.attachmentsOpen);
  const setAttachmentsOpen = useTasksBoardUiStore((state) => state.setAttachmentsOpen);
  const quota = useQuotaMenuModel(project?.serverId ?? null);

  const closeSheet = useCallback(() => setSheet(null), []);
  const openQuota = useCallback(() => setSheet("quota"), []);
  // The panel lives outside the menu (it is mounted by the screen), so picking
  // this item only flips the board's state and lets the menu close behind it.
  const toggleAttachments = useCallback(
    () => setAttachmentsOpen(!attachmentsOpen),
    [attachmentsOpen, setAttachmentsOpen],
  );
  const toggleExplorer = useCallback(
    () => setExplorerOpen(!explorerOpen),
    [explorerOpen, setExplorerOpen],
  );
  const openSettings = useCallback(() => {
    if (project) {
      router.navigate(buildProjectSettingsRoute(project.projectId));
    }
  }, [project]);

  const quotaLeading = useMemo(() => <QuotaRingIndicator model={quota} />, [quota]);
  const quotaTrailing = useMemo(
    () => (
      <Text style={styles.headerMenuValue}>
        {quota.remaining === null
          ? t("tasks.quota.noData")
          : t("tasks.quota.percentShort", { percent: Math.round(quota.remaining) })}
      </Text>
    ),
    [quota.remaining, t],
  );
  // Nothing to gather (project list level, host with no usage data): no button
  // rather than a "⋮" that opens an empty menu.
  if (!project && !quota.canFetch) {
    return null;
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={headerIconButtonStyle}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("tasks.headerMenu.label")}
          testID="tasks-header-overflow"
        >
          <ThemedMoreVertical size={ICON_SIZE.md} uniProps={mutedColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="bottom" width={260} testID="tasks-header-menu">
          {quota.canFetch ? (
            <DropdownMenuItem
              leading={quotaLeading}
              trailing={quotaTrailing}
              onSelect={openQuota}
              testID="tasks-header-menu-quota"
            >
              {t("tasks.quota.title")}
            </DropdownMenuItem>
          ) : null}
          {project ? (
            <DropdownMenuItem
              leading={HEADER_MENU_ICONS.explorer}
              selected={explorerOpen}
              onSelect={toggleExplorer}
              testID="tasks-header-menu-explorer"
            >
              {t("tasks.explorer.title")}
            </DropdownMenuItem>
          ) : null}
          {canAttach ? (
            <DropdownMenuItem
              leading={HEADER_MENU_ICONS.attachments}
              selected={attachmentsOpen}
              onSelect={toggleAttachments}
              testID="tasks-header-menu-attachments"
            >
              {t("tasks.headerMenu.attachments")}
            </DropdownMenuItem>
          ) : null}
          {project ? (
            <DropdownMenuItem
              leading={HEADER_MENU_ICONS.settings}
              onSelect={openSettings}
              testID="tasks-header-menu-settings"
            >
              {t("sidebar.project.actions.openSettings")}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <TasksHeaderMenuSheets quota={quota} openSheet={sheet} onClose={closeSheet} />
    </>
  );
}

/**
 * The drawers the compact header menu opens, mounted outside the menu itself:
 * a sheet rendered inside `DropdownMenuContent` would unmount with the menu the
 * moment the item is picked. (The attachments panel is not one of them — it is
 * mounted by the screen and only toggled from here.)
 */
function TasksHeaderMenuSheets({
  quota,
  openSheet,
  onClose,
}: {
  quota: QuotaMenuModel;
  openSheet: HeaderMenuSheet;
  onClose: () => void;
}) {
  if (!quota.canFetch) {
    return null;
  }
  return <TaskQuotaSheet model={quota} visible={openSheet === "quota"} onClose={onClose} />;
}

function TasksHeader({
  title,
  isCompact,
  supportsTasksBoard,
  selectedProject,
  projects,
}: {
  title: string;
  isCompact: boolean;
  supportsTasksBoard: boolean;
  selectedProject: ProjectEntry | null;
  projects: ProjectEntry[];
}) {
  // Top-right cluster: quota, explorer and attachments next to the project gear,
  // which stays one tap away on every drill-down level. On a phone they collapse
  // into a single "⋮" menu — the header there already carries the navigation,
  // and the row of icons ate the project name.
  const rightContent = useMemo(
    () =>
      isCompact ? (
        <View style={styles.headerRightCluster}>
          <NotificationHistoryButton />
          <TasksHeaderOverflowMenu project={selectedProject} />
        </View>
      ) : (
        <View style={styles.headerRightCluster}>
          <NotificationHistoryButton />
          <TaskQuotaMenuButton serverId={selectedProject?.serverId ?? null} />
          <TasksExplorerButton project={selectedProject} />
          <TasksAttachmentLibraryButton project={selectedProject} />
          {selectedProject ? <ProjectSettingsButton projectId={selectedProject.projectId} /> : null}
        </View>
      ),
    [isCompact, selectedProject],
  );
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

// Mobile board header: hamburger + back-to-projects chevron + a project-name
// dropdown that switches projects in place. A project has a single board, so
// this is the only board-level header there is.
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
              style={styles.projectSelector}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t("tasks.pickProject")}
              testID="tasks-header-project-selector"
            >
              <ProjectColorMark projectKey={currentProject.projectId} />
              <Text style={styles.projectSelectorLabel} numberOfLines={1}>
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
  const tasksByProject = useProjectBoardTasks(projects);
  const tones = useProjectToneMap(tasksByProject);
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

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  // Top-right header cluster: header actions + project gear side by side.
  headerIconButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
  },
  headerIconButtonHovered: {
    backgroundColor: theme.colors.surface1,
  },
  headerRightCluster: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  // Trailing number in the compact header menu (quota percent, pending count).
  headerMenuValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  headerMenuDot: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.primary,
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
    // Pin the rail's width so it is never squeezed by a wide neighbour: the
    // menu/task list must stay fully readable at every window size.
    flexShrink: 0,
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
  railItemAction: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  headerSettingsButton: {
    padding: theme.spacing[1],
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
    // minWidth:0 keeps the central board pane from being sized by the
    // min-content of its kanban columns. Without it the columns' combined
    // minimum width pushes the whole three-pane row past the window edge,
    // decaling the sidebar and turning the board's own horizontal scroll into
    // a page-wide one. overflow:hidden clips anything that still spills so the
    // legitimate column scroll stays confined to the board itself.
    minWidth: 0,
    overflow: "hidden",
  },
  // Tight vertical rhythm: the timeline sizes itself from its rows now, so the
  // space this used to reserve above the board goes back to the columns.
  boardContainer: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
  },
  // Compact keeps a single, even rhythm around the tab switch: the same 12px
  // sits above it (paddingTop) and below it (the container gap to the board),
  // so the tabs read as a balanced band under the header — not glued to it,
  // not floating in a big empty gap.
  boardContainerCompact: {
    flex: 1,
    gap: theme.spacing[2],
    paddingTop: theme.spacing[3],
  },
  // Compact board/timeline tab switch — full width, aligned to the board inset
  // (12) with breathing room below the header so it isn't glued to it.
  compactViewSwitch: {
    paddingHorizontal: theme.spacing[3],
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
  // Mobile board header: back chevron + project-name dropdown selector.
  boardHeaderLeft: {
    gap: theme.spacing[1],
  },
  boardHeaderBack: {
    padding: theme.spacing[1],
  },
  // Project pill in the compact board header (dot + name + chevron).
  projectSelector: {
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
  },
  projectSelectorLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  KanbanTask,
  TaskBilling,
  TaskBoard,
  TaskColumn,
  TaskRunConfig,
  TaskSchedulePreference,
} from "@getpaseo/protocol/tasks/types";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { getHostRuntimeStore, useHostRuntimeClient } from "@/runtime/host-runtime";

export type { TaskBilling, TaskBoard, TaskColumn, TaskRunConfig, TaskSchedulePreference };
export type { KanbanTask, TaskFolder } from "@getpaseo/protocol/tasks/types";

function createSubscriptionId(): string {
  return `tasks-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

export interface TaskBoardHandle {
  board: TaskBoard | null;
  isLoading: boolean;
  error: string | null;
  // No folder mutations: a project has exactly one task list, minted by the
  // server on demand. The tasks.folder.* RPCs stay on the wire for older
  // clients, but nothing in this app creates, renames or deletes a folder.
  createTask: (input: {
    /** The project's single list — see boardListId in the tasks screen. */
    folderId: string;
    title: string;
    description?: string;
    attachments?: AgentAttachment[];
    column?: TaskColumn;
    // Spawn the task's agent immediately (inline composer send). Omitted =
    // plain draft that only runs once dragged into the pipeline.
    launch?: boolean;
    // Priority/deadline/thematic tags, pre-serialized. Notes use this to carry
    // their importance + deadline without any agent involvement.
    tags?: string[];
  }) => Promise<void>;
  updateTask: (input: {
    taskId: string;
    title?: string;
    description?: string | null;
    tags?: string[];
    runConfig?: TaskRunConfig | null;
    schedulePreference?: TaskSchedulePreference | null;
    executionHold?: boolean | null;
    /** "Retirer du prochain lot": held back from the batch publication. */
    deployHold?: boolean | null;
  }) => Promise<void>;
  moveTask: (input: { taskId: string; column: TaskColumn; index: number }) => Promise<void>;
  markTaskViewed: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  estimateTask: (taskId: string) => Promise<void>;
  runTaskNow: (taskId: string) => Promise<void>;
  /** Clear a failed analysis and queue a fresh one. */
  retryTaskAnalysis: (taskId: string) => Promise<void>;
  approveTask: (taskId: string) => Promise<void>;
  /**
   * Finishes the task: moves it from "En cours" to "Terminé" and nothing else — no
   * check, no deployment (verification happens at publication time, see
   * docs/task-board-cycle.md). `queueOnComplete` is the "Terminer et mettre en
   * file" press: the card continues into "À déployer" right away instead of
   * resting in "Terminé".
   */
  validateTask: (
    taskId: string,
    options?: { queueOnComplete?: boolean },
  ) => Promise<{ passed: boolean; task: KanbanTask | null }>;
  /**
   * Hands the finished card's agent a deploy-then-confirm prompt. The deploy, the
   * move to "Déployée" and the daemon-restart flag all play out in the card's
   * conversation; this resolves once the prompt has been dispatched.
   */
  deployTask: (taskId: string) => Promise<{ dispatched: boolean; task: KanbanTask | null }>;
  /**
   * "Tout déployer": publishes every not-yet-live card of the "À déployer"
   * column in one run, then restarts the engine. Resolves as soon as the run has
   * started — the rest plays out on the board and in the cards' conversations.
   */
  deployAllTasks: () => Promise<{ started: boolean; taskIds: string[] }>;
  /**
   * Archive (hide) a finished card, or un-archive it. Stamps `archivedAt`
   * server-side; never moves or publishes the card.
   */
  archiveTask: (taskId: string, archived?: boolean) => Promise<void>;
}

/**
 * Live per-project kanban board: subscribes to the daemon on mount, applies
 * tasks.board.update pushes (the server snapshot is authoritative), and
 * exposes thin RPC mutation helpers. DnD applies moves optimistically via
 * setBoard before the server push lands.
 */
export function useTaskBoard(serverId: string | null, projectId: string | null): TaskBoardHandle {
  const { t } = useTranslation();
  const [board, setBoard] = useState<TaskBoard | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boardRef = useRef<TaskBoard | null>(null);
  boardRef.current = board;

  const getClient = useCallback(() => {
    if (!serverId) {
      return null;
    }
    return getHostRuntimeStore().getClient(serverId);
  }, [serverId]);

  // Reactive client: on a cold load straight onto the tasks screen the host
  // connects after mount, and the subscription must re-run once the client
  // appears instead of latching a permanent "not connected" error.
  const liveClient = useHostRuntimeClient(serverId ?? "");

  useEffect(() => {
    if (!serverId || !projectId) {
      setBoard(null);
      setError(null);
      return;
    }
    const client = liveClient;
    if (!client) {
      setError(t("workspace.terminal.hostDisconnected"));
      return;
    }
    let disposed = false;
    const subscriptionId = createSubscriptionId();
    // Drop the previous project's board so its folders/tasks don't linger while
    // the new subscription loads (otherwise stale content flashes on switch).
    setBoard(null);
    setIsLoading(true);
    setError(null);
    const unsubscribePush = client.on("tasks.board.update", (message) => {
      if (message.payload.subscriptionId !== subscriptionId) {
        return;
      }
      setBoard(message.payload.board);
    });
    const runSubscribe = async () => {
      try {
        const payload = await client.tasksBoardSubscribe(projectId, subscriptionId);
        if (disposed) {
          return;
        }
        if (payload.error) {
          setError(payload.error);
        } else {
          setBoard(payload.board);
        }
      } catch (subscribeError) {
        if (!disposed) {
          setError(
            subscribeError instanceof Error ? subscribeError.message : String(subscribeError),
          );
        }
      } finally {
        if (!disposed) {
          setIsLoading(false);
        }
      }
    };
    void runSubscribe();
    return () => {
      disposed = true;
      unsubscribePush();
      client.tasksBoardUnsubscribe(subscriptionId).catch(() => {
        // Socket may already be gone; the server also cleans up on disconnect.
      });
    };
  }, [serverId, projectId, liveClient, t]);

  const requireContext = useCallback(() => {
    const client = getClient();
    if (!client || !projectId) {
      throw new Error("Task board is not connected");
    }
    return { client, projectId };
  }, [getClient, projectId]);

  const createTask = useCallback(
    async (input: {
      folderId: string;
      title: string;
      description?: string;
      attachments?: AgentAttachment[];
      column?: TaskColumn;
      launch?: boolean;
      tags?: string[];
    }) => {
      const { client, projectId: project } = requireContext();
      await client.tasksTaskCreate({ projectId: project, ...input });
    },
    [requireContext],
  );

  const updateTask = useCallback(
    async (input: {
      taskId: string;
      title?: string;
      description?: string | null;
      tags?: string[];
      runConfig?: TaskRunConfig | null;
      schedulePreference?: TaskSchedulePreference | null;
      executionHold?: boolean | null;
      deployHold?: boolean | null;
    }) => {
      const { client, projectId: project } = requireContext();
      await client.tasksTaskUpdate({ projectId: project, ...input });
    },
    [requireContext],
  );

  const moveTask = useCallback(
    async (input: { taskId: string; column: TaskColumn; index: number }) => {
      const { client, projectId: project } = requireContext();
      // Optimistic local move so the card doesn't snap back while the RPC runs.
      const current = boardRef.current;
      const task = current?.tasks.find((entry) => entry.id === input.taskId);
      if (current && task) {
        const optimistic = { ...task, column: input.column, order: input.index };
        setBoard({
          ...current,
          tasks: current.tasks.map((entry) => (entry.id === input.taskId ? optimistic : entry)),
        });
      }
      const payload = await client.tasksTaskMove({ projectId: project, ...input });
      if (payload.board) {
        setBoard(payload.board);
      }
    },
    [requireContext],
  );

  const markTaskViewed = useCallback(
    async (taskId: string) => {
      const { client, projectId: project } = requireContext();
      // Optimistic: stamp locally so the card dims the instant it's opened,
      // without waiting for the server push. viewedAt never affects sort order.
      const current = boardRef.current;
      const task = current?.tasks.find((entry) => entry.id === taskId);
      if (current && task && !task.viewedAt) {
        const stamped = { ...task, viewedAt: new Date().toISOString() };
        setBoard({
          ...current,
          tasks: current.tasks.map((entry) => (entry.id === taskId ? stamped : entry)),
        });
      }
      const payload = await client.tasksTaskMarkViewed({ projectId: project, taskId });
      if (payload.board) {
        setBoard(payload.board);
      }
    },
    [requireContext],
  );

  const deleteTask = useCallback(
    async (taskId: string) => {
      const { client, projectId: project } = requireContext();
      await client.tasksTaskDelete({ projectId: project, taskId });
    },
    [requireContext],
  );

  const estimateTask = useCallback(
    async (taskId: string) => {
      const { client, projectId: project } = requireContext();
      await client.tasksTaskEstimate({ projectId: project, taskId });
    },
    [requireContext],
  );

  const runTaskNow = useCallback(
    async (taskId: string) => {
      const { client, projectId: project } = requireContext();
      await client.tasksTaskRunNow({ projectId: project, taskId });
    },
    [requireContext],
  );

  const retryTaskAnalysis = useCallback(
    async (taskId: string) => {
      const { client, projectId: project } = requireContext();
      const payload = await client.tasksTaskRetryAnalysis({ projectId: project, taskId });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    [requireContext],
  );

  const approveTask = useCallback(
    async (taskId: string) => {
      const { client, projectId: project } = requireContext();
      const payload = await client.tasksTaskApprove({ projectId: project, taskId });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    [requireContext],
  );

  const validateTask = useCallback(
    async (taskId: string, options?: { queueOnComplete?: boolean }) => {
      const { client, projectId: project } = requireContext();
      const payload = await client.tasksTaskValidate({
        projectId: project,
        taskId,
        queueOnComplete: options?.queueOnComplete === true,
      });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return { passed: payload.passed, task: payload.task };
    },
    [requireContext],
  );

  const deployTask = useCallback(
    async (taskId: string) => {
      const { client, projectId: project } = requireContext();
      const payload = await client.tasksTaskDeploy({ projectId: project, taskId });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return { dispatched: payload.dispatched ?? false, task: payload.task };
    },
    [requireContext],
  );

  const deployAllTasks = useCallback(async () => {
    const { client, projectId: project } = requireContext();
    const payload = await client.tasksBoardDeployAll({ projectId: project });
    if (payload.error) {
      throw new Error(payload.error);
    }
    return { started: payload.started, taskIds: payload.taskIds ?? [] };
  }, [requireContext]);

  const archiveTask = useCallback(
    async (taskId: string, archived = true) => {
      const { client, projectId: project } = requireContext();
      const payload = await client.tasksTaskArchive({ projectId: project, taskId, archived });
      if (payload.error) {
        throw new Error(payload.error);
      }
    },
    [requireContext],
  );

  // Archived cards are hidden from every board consumer (kanban columns, rails,
  // counts): the daemon still stores them, but archiving is a "file it away"
  // gesture, so they drop out of view here. Filtering at this single chokepoint
  // keeps the rest of the UI unaware of the concept.
  const visibleBoard = useMemo(
    () => (board ? { ...board, tasks: board.tasks.filter((task) => !task.archivedAt) } : null),
    [board],
  );

  return useMemo(
    () => ({
      board: visibleBoard,
      isLoading,
      error,
      createTask,
      updateTask,
      moveTask,
      markTaskViewed,
      deleteTask,
      estimateTask,
      runTaskNow,
      retryTaskAnalysis,
      approveTask,
      validateTask,
      deployTask,
      deployAllTasks,
      archiveTask,
    }),
    [
      visibleBoard,
      isLoading,
      error,
      createTask,
      updateTask,
      moveTask,
      markTaskViewed,
      deleteTask,
      estimateTask,
      runTaskNow,
      retryTaskAnalysis,
      approveTask,
      validateTask,
      deployTask,
      deployAllTasks,
      archiveTask,
    ],
  );
}

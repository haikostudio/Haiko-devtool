import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
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
  createFolder: (input: {
    name: string;
    color?: string;
    autopilot?: boolean;
    branch?: string;
  }) => Promise<void>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  updateFolder: (input: {
    folderId: string;
    name?: string;
    color?: string;
    autopilot?: boolean;
    branch?: string;
  }) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  createTask: (input: {
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
  }) => Promise<void>;
  moveTask: (input: { taskId: string; column: TaskColumn; index: number }) => Promise<void>;
  markTaskViewed: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  estimateTask: (taskId: string) => Promise<void>;
  runTaskNow: (taskId: string) => Promise<void>;
  approveTask: (taskId: string) => Promise<void>;
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

  const createFolder = useCallback(
    async (input: { name: string; color?: string; autopilot?: boolean; branch?: string }) => {
      const { client, projectId: project } = requireContext();
      await client.tasksFolderCreate({ projectId: project, ...input });
    },
    [requireContext],
  );

  const renameFolder = useCallback(
    async (folderId: string, name: string) => {
      const { client, projectId: project } = requireContext();
      await client.tasksFolderUpdate({ projectId: project, folderId, name });
    },
    [requireContext],
  );

  const updateFolder = useCallback(
    async (input: {
      folderId: string;
      name?: string;
      color?: string;
      autopilot?: boolean;
      branch?: string;
    }) => {
      const { client, projectId: project } = requireContext();
      await client.tasksFolderUpdate({ projectId: project, ...input });
    },
    [requireContext],
  );

  const deleteFolder = useCallback(
    async (folderId: string) => {
      const { client, projectId: project } = requireContext();
      await client.tasksFolderDelete({ projectId: project, folderId });
    },
    [requireContext],
  );

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

  return useMemo(
    () => ({
      board,
      isLoading,
      error,
      createFolder,
      renameFolder,
      updateFolder,
      deleteFolder,
      createTask,
      updateTask,
      moveTask,
      markTaskViewed,
      deleteTask,
      estimateTask,
      runTaskNow,
      approveTask,
    }),
    [
      board,
      isLoading,
      error,
      createFolder,
      renameFolder,
      updateFolder,
      deleteFolder,
      createTask,
      updateTask,
      moveTask,
      markTaskViewed,
      deleteTask,
      estimateTask,
      runTaskNow,
      approveTask,
    ],
  );
}

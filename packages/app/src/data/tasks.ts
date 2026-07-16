import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskBoard, TaskColumn } from "@getpaseo/protocol/tasks/types";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export type { TaskBoard, TaskColumn };
export type { KanbanTask, TaskFolder } from "@getpaseo/protocol/tasks/types";

function createSubscriptionId(): string {
  return `tasks-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

export interface TaskBoardHandle {
  board: TaskBoard | null;
  isLoading: boolean;
  error: string | null;
  createFolder: (input: { name: string; color?: string }) => Promise<void>;
  renameFolder: (folderId: string, name: string) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  createTask: (input: {
    folderId: string;
    title: string;
    description?: string;
    column?: TaskColumn;
  }) => Promise<void>;
  updateTask: (input: {
    taskId: string;
    title?: string;
    description?: string | null;
    tags?: string[];
  }) => Promise<void>;
  moveTask: (input: { taskId: string; column: TaskColumn; index: number }) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
  estimateTask: (taskId: string) => Promise<void>;
  runTaskNow: (taskId: string) => Promise<void>;
}

/**
 * Live per-project kanban board: subscribes to the daemon on mount, applies
 * tasks.board.update pushes (the server snapshot is authoritative), and
 * exposes thin RPC mutation helpers. DnD applies moves optimistically via
 * setBoard before the server push lands.
 */
export function useTaskBoard(serverId: string | null, projectId: string | null): TaskBoardHandle {
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

  useEffect(() => {
    if (!serverId || !projectId) {
      setBoard(null);
      setError(null);
      return;
    }
    const client = getHostRuntimeStore().getClient(serverId);
    if (!client) {
      setError("Host is not connected");
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
  }, [serverId, projectId]);

  const requireContext = useCallback(() => {
    const client = getClient();
    if (!client || !projectId) {
      throw new Error("Task board is not connected");
    }
    return { client, projectId };
  }, [getClient, projectId]);

  const createFolder = useCallback(
    async (input: { name: string; color?: string }) => {
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
      column?: TaskColumn;
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

  return useMemo(
    () => ({
      board,
      isLoading,
      error,
      createFolder,
      renameFolder,
      deleteFolder,
      createTask,
      updateTask,
      moveTask,
      deleteTask,
      estimateTask,
      runTaskNow,
    }),
    [
      board,
      isLoading,
      error,
      createFolder,
      renameFolder,
      deleteFolder,
      createTask,
      updateTask,
      moveTask,
      deleteTask,
      estimateTask,
      runTaskNow,
    ],
  );
}

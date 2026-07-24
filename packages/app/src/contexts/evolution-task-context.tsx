import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

/**
 * Lets an agent chat message turn a proposed "Évolutions possibles" bullet into
 * a real kanban task. The task drawer knows the server/project/folder the chat
 * belongs to; it publishes that context here so the deeply-nested markdown
 * renderer (which only receives the message string) can create a task without
 * threading props through the generic workspace pane in between.
 *
 * Null when the chat is not shown inside a task (e.g. the plain workspace
 * screen) — the create-task buttons simply don't render there.
 */
export interface EvolutionTaskCreator {
  createTask: (input: { title: string; description?: string }) => Promise<void>;
}

const EvolutionTaskContext = createContext<EvolutionTaskCreator | null>(null);

export function useEvolutionTaskCreator(): EvolutionTaskCreator | null {
  return useContext(EvolutionTaskContext);
}

export function EvolutionTaskProvider({
  serverId,
  projectId,
  folderId,
  children,
}: {
  serverId: string | null;
  projectId: string | null;
  folderId: string | null;
  children: ReactNode;
}) {
  const createTask = useCallback(
    async (input: { title: string; description?: string }) => {
      if (!serverId || !projectId || !folderId) {
        throw new Error("Task context unavailable");
      }
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) {
        throw new Error("Host not connected");
      }
      // New tasks land in the backlog ("À faire") column, same as the board's
      // add-task affordance.
      await client.tasksTaskCreate({
        projectId,
        folderId,
        title: input.title,
        description: input.description,
        column: "backlog",
      });
    },
    [serverId, projectId, folderId],
  );

  const value = useMemo<EvolutionTaskCreator | null>(() => {
    if (!serverId || !projectId || !folderId) {
      return null;
    }
    return { createTask };
  }, [serverId, projectId, folderId, createTask]);

  return <EvolutionTaskContext.Provider value={value}>{children}</EvolutionTaskContext.Provider>;
}

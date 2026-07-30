/**
 * Picks the answer structure a card's agent must follow, from where the card
 * currently sits on the board.
 *
 * The card templates (analysis / progress / publication) are described in
 * docs/response-templates.md — this module is the column → template map plus the
 * plumbing that finds a card (or the grouped-deployment agent) from an agent id.
 *
 * The mapping is deliberately a pure function of the task, so the rule is
 * testable without a board, a registry or an agent.
 */

import type pino from "pino";
import { isConductorAgent, isDeploymentAgent } from "@getpaseo/protocol/agent-labels";
import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type {
  ResponseFormatTemplate,
  ResponseFormatTemplateHook,
} from "../../services/response-format.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { TASK_AGENT_LABEL } from "./agent-launch.js";
import type { TaskBoardService } from "./service.js";
import { isTaskLive } from "./batch-deployer.js";

/**
 * Column → template. Three refinements on top of the plain column reading:
 *  - a deployment in flight, or work already live, wins over the column: that
 *    turn IS the publication log, and it is also the turn that verifies the work
 *    (finishing a card no longer runs a check of its own);
 *  - "À déployer" alone does NOT mean published — it is the queue a finished
 *    card waits in — so a card sitting there still reports its work;
 *  - "Planifié" reads like "Validé" (analysis already produced, execution not
 *    started) and "Terminée" like "En cours" (the work report), so a card never
 *    falls back to the generic five-section shape mid-cycle.
 */
export function resolveTaskResponseTemplate(task: KanbanTask): ResponseFormatTemplate {
  if (task.deployment?.state === "running" || isTaskLive(task)) {
    return "publication";
  }
  switch (task.column) {
    case "validated":
    case "scheduled":
      return "analysis";
    case "in_progress":
    case "done":
    case "deployed":
      return "progress";
    default:
      // "backlog" and "notes" are inert columns: nothing runs there, and a
      // question asked from such a card is plain conversation.
      return "default";
  }
}

interface TaskResponseTemplateHookOptions {
  agentManager: Pick<AgentManager, "getAgent">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  taskBoardService: Pick<TaskBoardService, "getBoard">;
  logger: pino.Logger;
}

/**
 * Builds the hook the AgentManager consults on every dispatch: agent → card →
 * column → template. Returns null for anything that is not a card agent, which
 * leaves the default five-section report in place.
 *
 * The agent → (project, task) link never changes for a given agent, so it is
 * cached; the COLUMN is read fresh every time, because the whole point is that
 * moving a card changes the shape of its next answer.
 */
export function createTaskResponseTemplateHook(
  options: TaskResponseTemplateHookOptions,
): ResponseFormatTemplateHook {
  // agentId -> { projectId, taskId } | null ("resolved as not a card agent")
  const links = new Map<string, { projectId: string; taskId: string } | null>();

  async function resolveLink(
    agentId: string,
  ): Promise<{ projectId: string; taskId: string } | null> {
    if (links.has(agentId)) {
      return links.get(agentId) ?? null;
    }
    const agent = options.agentManager.getAgent(agentId);
    const taskId = agent?.labels?.[TASK_AGENT_LABEL];
    let link: { projectId: string; taskId: string } | null = null;
    if (taskId && agent?.workspaceId) {
      const workspace = await options.workspaceRegistry.get(agent.workspaceId);
      const projectId = workspace?.projectId ?? null;
      if (projectId) {
        link = { projectId, taskId };
      }
    }
    // Only a resolved link (or a definitive "no task label") is worth caching;
    // a card agent whose workspace is not registered yet may resolve later.
    if (link || !taskId) {
      links.set(agentId, link);
    }
    return link;
  }

  return async ({ agentId }) => {
    try {
      const labels = options.agentManager.getAgent(agentId)?.labels ?? null;
      // The conductor is not a card agent, so it would otherwise fall through to
      // the generic five-section report — and answer a plain question with a
      // work report and an invoice line. It has its own shape.
      if (isConductorAgent({ labels })) {
        return "conductor";
      }
      // The grouped-deployment agent spans several cards, so it has no single
      // column to read: it is routed by its deployment role label straight to
      // the batch publication log.
      if (isDeploymentAgent({ labels })) {
        return "batchPublication";
      }
      const link = await resolveLink(agentId);
      if (!link) {
        return null;
      }
      const board = await options.taskBoardService.getBoard(link.projectId);
      const task = board.tasks.find((candidate) => candidate.id === link.taskId);
      return task ? resolveTaskResponseTemplate(task) : null;
    } catch (error) {
      options.logger.debug({ err: error, agentId }, "Response template resolution failed");
      return null;
    }
  };
}

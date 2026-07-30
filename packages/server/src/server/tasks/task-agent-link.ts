import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import type { AgentManager } from "../agent/agent-manager.js";

/**
 * The agent side of a card: which agent holds its conversation, and how to tell
 * when that agent has stopped talking.
 *
 * These used to live in `validator.ts`, back when the final check was an agent
 * prompt. Finishing a card is now a pure column move (see {@link TaskValidator}),
 * so the only consumer left is the deploy path — which is where a card's agent
 * really does work on the user's behalf.
 */

/**
 * The pipeline agent holds the task's real conversation (analysis AND execution).
 * Fall back to whatever agent the board has on file for older cards.
 */
export function resolveTaskAgentId(task: KanbanTask): string | null {
  return task.links.taskAgentId ?? task.links.primaryAgentId ?? task.links.agentIds.at(-1) ?? null;
}

/** Minimal slice of AgentManager the idle watcher needs. */
export type AgentIdleWatcherHost = Pick<AgentManager, "subscribe" | "getAgent">;
export type AgentStopReason = "idle" | "error" | "closed";

/**
 * Fires `onIdle` the first time the agent stops working after a prompt.
 * Errors and closures count as "stopped" — a deploy must never leave the bar
 * waiting on an agent that will never answer.
 */
export function watchAgentIdle(
  agentManager: AgentIdleWatcherHost,
  agentId: string,
  onIdle: (reason: AgentStopReason) => void,
): () => void {
  let sawRunning = agentManager.getAgent(agentId)?.lifecycle === "running";
  let fired = false;
  let unsubscribe: (() => void) | null = null;

  function finish(reason: AgentStopReason): void {
    if (fired) {
      return;
    }
    fired = true;
    unsubscribe?.();
    onIdle(reason);
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (fired || event.type !== "agent_state") {
        return;
      }
      if (event.agent.lifecycle === "running") {
        sawRunning = true;
        return;
      }
      if (event.agent.lifecycle === "closed" || event.agent.lifecycle === "error") {
        finish(event.agent.lifecycle);
        return;
      }
      if (event.agent.lifecycle === "idle" && sawRunning) {
        finish("idle");
      }
    },
    { agentId, replayState: false },
  );

  if (fired) {
    unsubscribe();
  }
  return () => {
    fired = true;
    unsubscribe?.();
  };
}

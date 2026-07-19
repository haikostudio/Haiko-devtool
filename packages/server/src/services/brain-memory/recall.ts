import type { AgentManager } from "../../server/agent/agent-manager.js";
import {
  type BrainMemoryClient,
  formatRecall,
  injectBrainContext,
  toTimelineMemories,
} from "./client.js";
import { type BrainCurator, briefToSouvenir } from "./curator.js";

/** Minimal logger surface — accepts pino-style child loggers. */
interface BrainRecallLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

export interface BrainRecallDeps {
  brain: BrainMemoryClient | null;
  curator: BrainCurator | null;
  agentManager: Pick<AgentManager, "appendTimelineItem" | "getLastAssistantMessage">;
  logger: BrainRecallLogger;
}

export interface BrainScope {
  projet: string | undefined;
  cwd: string | null;
}

/**
 * Recall relevant memories from the Cerveau, surface them as a yellow
 * brain_context timeline item, and return the prompt augmented with the recall
 * block. Shared by every prompt-dispatch path — interactive client messages
 * (session) AND programmatic launches (task scheduler, schedules) — so the
 * Cerveau reaches the agent the same way everywhere: server-side injection,
 * never a tool the model calls on its own.
 *
 * Entirely best-effort: a Cerveau outage returns the text unchanged and never
 * blocks the prompt.
 */
export async function recallAndInjectBrainContext(
  deps: BrainRecallDeps,
  input: { agentId: string; text: string; scope: BrainScope },
): Promise<string> {
  const { brain, curator, agentManager, logger } = deps;
  const { agentId, text, scope } = input;
  if (!brain || !text.trim()) {
    return text;
  }
  // Recall fires on every non-empty prompt (no substance gate): each turn
  // re-queries the Cerveau to pull in newly-relevant context. The librarian
  // below still filters to what matters, so bare follow-ups usually surface
  // nothing.
  let isFirstPrompt = false;
  try {
    isFirstPrompt = (await agentManager.getLastAssistantMessage(agentId)) === null;
  } catch (err) {
    logger.debug({ err, agentId }, "brain: first-prompt detection failed");
  }
  let recall: Awaited<ReturnType<BrainMemoryClient["recall"]>>;
  try {
    recall = await brain.recall(text, { projet: scope.projet });
  } catch (err) {
    logger.debug({ err, agentId }, "brain: recall failed");
    return text;
  }
  const brief = curator && scope.projet ? await curator.loadBrief(scope.projet) : null;
  let kept = recall.resultats;
  if (curator && scope.cwd && kept.length > 0) {
    const filtered = await curator.filterRecall({
      prompt: text,
      memories: kept,
      brief,
      projet: scope.projet,
      cwd: scope.cwd,
    });
    if (filtered) {
      kept = filtered;
    }
  }
  if (isFirstPrompt && brief && scope.projet) {
    kept = [briefToSouvenir(scope.projet, brief), ...kept];
  }
  // Always surface the pill — even with 0 memories — so the user sees the
  // Cerveau was queried on this prompt (the client renders "aucune info
  // complémentaire" for an empty recall).
  try {
    await agentManager.appendTimelineItem(agentId, {
      type: "brain_context",
      query: text.slice(0, 500),
      portee: recall.portee,
      count: kept.length,
      memories: toTimelineMemories(kept),
      status: "done",
    });
    logger.info(
      { module: "brain-memory", agentId, count: kept.length, portee: recall.portee },
      "Cerveau: pill emitted",
    );
  } catch (err) {
    logger.debug({ err, agentId }, "brain: timeline emit failed");
  }
  if (kept.length === 0) {
    return text;
  }
  return injectBrainContext(formatRecall(kept), recall.portee, text);
}

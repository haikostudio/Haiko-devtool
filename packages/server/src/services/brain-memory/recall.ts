import type { AgentManager } from "../../server/agent/agent-manager.js";
import type { AgentStorage } from "../../server/agent/agent-storage.js";
import {
  type ProjectRegistry,
  resolveProjectDisplayName,
  type WorkspaceRegistry,
} from "../../server/workspace-registry.js";
import {
  type BrainMemoryClient,
  foldText,
  formatRecall,
  injectBrainContext,
  toTimelineMemories,
} from "./client.js";
import { type BrainCurator, briefToSouvenir } from "./curator.js";
import type { RecentFactsStore } from "./recent-facts.js";

/** Minimal logger surface — accepts pino-style child loggers. */
interface BrainRecallLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

export interface BrainRecallDeps {
  brain: BrainMemoryClient | null;
  curator: BrainCurator | null;
  recentFacts?: RecentFactsStore | null;
  isEnabled?: () => boolean;
  agentManager: Pick<AgentManager, "appendTimelineItem" | "getLastAssistantMessage">;
  logger: BrainRecallLogger;
}

export interface BrainScope {
  projet: string | undefined;
  cwd: string | null;
}

export interface BrainScopeDeps {
  agentStorage: Pick<AgentStorage, "get">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  projectRegistry: Pick<ProjectRegistry, "get">;
  logger: BrainRecallLogger;
}

/**
 * Resolve the Cerveau scope for an agent: the project display name when the
 * agent belongs to a workspace, otherwise the last segment of its working
 * directory, plus the cwd the curator's internal agents run in. Best-effort —
 * empty scope on any failure.
 */
export async function resolveBrainScope(
  deps: BrainScopeDeps,
  agentId: string,
): Promise<BrainScope> {
  try {
    const agent = await deps.agentStorage.get(agentId);
    if (!agent) {
      return { projet: undefined, cwd: null };
    }
    if (agent.workspaceId) {
      const workspace = await deps.workspaceRegistry.get(agent.workspaceId);
      if (workspace) {
        const project = await deps.projectRegistry.get(workspace.projectId);
        if (project) {
          return { projet: resolveProjectDisplayName(project), cwd: agent.cwd };
        }
      }
    }
    const segments = agent.cwd.replace(/\\/g, "/").split("/").filter(Boolean);
    return { projet: segments[segments.length - 1] ?? undefined, cwd: agent.cwd };
  } catch (err) {
    deps.logger.debug({ err, agentId }, "brain: scope resolution failed");
    return { projet: undefined, cwd: null };
  }
}

/**
 * Prompt-level recall hook installed on the AgentManager at bootstrap and
 * applied to every foreground prompt of every non-internal agent — whatever
 * the entrypoint (session message, MCP send_agent_prompt, schedules, loops,
 * task launches, notify-on-finish). Takes the prompt text, returns it
 * augmented with the Cerveau recall block (or unchanged on outage).
 */
export type BrainRecallPromptHook = (input: { agentId: string; text: string }) => Promise<string>;

/**
 * Build the AgentManager prompt hook: resolve the agent's scope, then run the
 * standard recall (yellow pill + <contexte_memoire> injection). One hook at
 * the dispatch choke point instead of a recall call per entrypoint — new
 * prompt paths get the Cerveau for free.
 */
export function createBrainRecallHook(
  deps: BrainRecallDeps & BrainScopeDeps,
): BrainRecallPromptHook {
  return async ({ agentId, text }) => {
    const scope = await resolveBrainScope(deps, agentId);
    return recallAndInjectBrainContext(deps, { agentId, text, scope });
  };
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
/**
 * Tail of the last assistant message = "what the conversation is about" right
 * now. The Cerveau uses it as a sense witness to disambiguate polysemous
 * prompt words ("espace" in a design conversation = layout spacing) — see
 * contexte_conversation in the search API.
 */
function conversationWitness(lastAssistant: string | null): string | undefined {
  if (!lastAssistant) {
    return undefined;
  }
  return lastAssistant.replace(/\s+/g, " ").trim().slice(-400);
}

export async function recallAndInjectBrainContext(
  deps: BrainRecallDeps,
  input: { agentId: string; text: string; scope: BrainScope },
): Promise<string> {
  const { brain, curator, recentFacts, agentManager, logger, isEnabled } = deps;
  const { agentId, text, scope } = input;
  if (!brain || shouldSkipBrainRecall({ text, isEnabled })) {
    return text;
  }
  // Recall fires on every non-empty prompt (no substance gate): each turn
  // re-queries the Cerveau to pull in newly-relevant context. The librarian
  // below still filters to what matters, so bare follow-ups usually surface
  // nothing.
  let isFirstPrompt = false;
  let lastAssistant: string | null = null;
  try {
    lastAssistant = await agentManager.getLastAssistantMessage(agentId);
    isFirstPrompt = lastAssistant === null;
  } catch (err) {
    logger.debug({ err, agentId }, "brain: first-prompt detection failed");
  }
  const contexteConversation = conversationWitness(lastAssistant);
  let recall: Awaited<ReturnType<BrainMemoryClient["recall"]>>;
  try {
    recall = await brain.recall(text, { projet: scope.projet, contexteConversation });
  } catch (err) {
    logger.debug({ err, agentId }, "brain: recall failed");
    return text;
  }
  const brief = curator && scope.projet ? await curator.loadBrief(scope.projet) : null;
  let kept = recall.resultats;
  kept = await prependRecentFacts({ recentFacts, kept, projet: scope.projet, agentId, logger });
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
  await emitBrainContextPill({
    agentManager,
    agentId,
    text,
    recallPortee: recall.portee,
    kept,
    logger,
  });
  if (kept.length === 0) {
    return text;
  }
  return injectBrainContext(formatRecall(kept), recall.portee, text);
}

function shouldSkipBrainRecall(input: { text: string; isEnabled?: () => boolean }): boolean {
  return !input.text.trim() || input.isEnabled?.() === false;
}

async function prependRecentFacts(input: {
  recentFacts: RecentFactsStore | null | undefined;
  kept: Awaited<ReturnType<BrainMemoryClient["recall"]>>["resultats"];
  projet: string | undefined;
  agentId: string;
  logger: BrainRecallLogger;
}): Promise<Awaited<ReturnType<BrainMemoryClient["recall"]>>["resultats"]> {
  const { recentFacts, kept, projet, agentId, logger } = input;
  if (!recentFacts || !projet) {
    return kept;
  }
  try {
    const fresh = await recentFacts.load(projet);
    if (fresh.length === 0) {
      return kept;
    }
    const seen = new Set(kept.map((memory) => foldText((memory.texte ?? "").trim())));
    const extras = fresh
      .filter((texte) => !seen.has(foldText(texte.trim())))
      .map((texte) => ({ texte }));
    return [...extras, ...kept];
  } catch (err) {
    logger.debug({ err, agentId }, "brain: recent-facts load failed");
    return kept;
  }
}

async function emitBrainContextPill(input: {
  agentManager: Pick<AgentManager, "appendTimelineItem">;
  agentId: string;
  text: string;
  recallPortee: "projet" | "global" | "apercu";
  kept: Awaited<ReturnType<BrainMemoryClient["recall"]>>["resultats"];
  logger: BrainRecallLogger;
}): Promise<void> {
  const { agentManager, agentId, text, recallPortee, kept, logger } = input;
  try {
    await agentManager.appendTimelineItem(agentId, {
      type: "brain_context",
      query: text.slice(0, 500),
      portee: recallPortee,
      count: kept.length,
      memories: toTimelineMemories(kept),
      status: "done",
    });
    logger.info(
      { module: "brain-memory", agentId, count: kept.length, portee: recallPortee },
      "Cerveau: pill emitted",
    );
  } catch (err) {
    logger.debug({ err, agentId }, "brain: timeline emit failed");
  }
}

import type { AgentManager } from "../../server/agent/agent-manager.js";
import type { BrainMemoryClient } from "./client.js";
import type { BrainCurator } from "./curator.js";
import { type BrainScopeDeps, resolveBrainScope } from "./recall.js";
import { summarizeTurnActions } from "./turn-actions.js";

/** Minimal logger surface — accepts pino-style child loggers. */
interface BrainCaptureLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

export interface BrainCaptureDeps {
  brain: BrainMemoryClient | null;
  curator: BrainCurator | null;
  isEnabled?: () => boolean;
  agentManager: Pick<AgentManager, "subscribe" | "getTimeline" | "getLastAssistantMessage">;
  logger: BrainCaptureLogger;
}

/**
 * End-of-turn capture hook installed on the AgentManager at bootstrap, symmetric
 * to the recall hook: it fires for every FRESH foreground prompt of every
 * non-internal agent — session message, MCP send_agent_prompt, schedules,
 * loops, task launches — so the Cerveau learns from autonomous work (a task that
 * commits and deploys) the same way it learns from an interactive chat, not just
 * from the one session path that used to schedule this by hand. Fire-and-forget:
 * it schedules a one-shot subscription and returns immediately.
 */
export type BrainCapturePromptHook = (input: { agentId: string; text: string }) => void;

/**
 * Build the AgentManager capture hook: on each fresh prompt, snapshot the
 * timeline length and, when the turn ends, distill the exchange (durable facts +
 * fiche refresh via the scribe) including the durable actions taken this turn.
 * The single choke point replaces the per-call-site scheduling session.ts used
 * to do — new prompt paths get end-of-turn capture for free.
 */
export function createBrainCaptureHook(
  deps: BrainCaptureDeps & BrainScopeDeps,
): BrainCapturePromptHook {
  return ({ agentId, text }) => {
    scheduleBrainCapture(deps, agentId, text);
  };
}

/**
 * Subscribe once for the agent's next terminal turn event and, on completion,
 * capture the exchange into the Cerveau. With the curator (scribe): completed
 * turns only, distilled into durable facts + a fiche refresh, enriched with the
 * turn's durable actions (commits, deploys). Without it: legacy raw note.
 * Entirely best-effort — a Cerveau outage never blocks or surfaces.
 */
function scheduleBrainCapture(
  deps: BrainCaptureDeps & BrainScopeDeps,
  agentId: string,
  userText: string,
): void {
  const { brain, curator, agentManager, logger, isEnabled } = deps;
  if (!brain || !userText.trim() || isEnabled?.() === false) {
    return;
  }
  // Snapshot now so we can isolate THIS turn's items at completion and distill
  // the durable actions taken (not just what was said). 0 means "whole timeline".
  let fromIndex = 0;
  try {
    fromIndex = agentManager.getTimeline(agentId).length;
  } catch {
    fromIndex = 0;
  }
  const unsubscribe = agentManager.subscribe(
    (event) => {
      if (event.type !== "agent_stream") {
        return;
      }
      const eventType = event.event.type;
      if (
        eventType !== "turn_completed" &&
        eventType !== "turn_failed" &&
        eventType !== "turn_canceled"
      ) {
        return;
      }
      unsubscribe();
      void (async () => {
        try {
          if (isEnabled?.() === false) {
            return;
          }
          const scope = await resolveBrainScope(deps, agentId);
          const finalText =
            eventType === "turn_completed"
              ? ((await agentManager.getLastAssistantMessage(agentId)) ?? "")
              : "";
          if (curator) {
            if (eventType !== "turn_completed" || !scope.cwd) {
              return;
            }
            let actions: string | null = null;
            try {
              actions = summarizeTurnActions(agentManager.getTimeline(agentId).slice(fromIndex));
            } catch {
              actions = null;
            }
            await curator.distillExchange({
              userText,
              assistantText: finalText,
              projet: scope.projet,
              cwd: scope.cwd,
              discussionId: agentId,
              actions,
            });
            return;
          }
          const note = finalText
            ? `Utilisateur: ${userText}\n\nAssistant: ${finalText}`
            : `Utilisateur: ${userText}`;
          await brain.note(note, {
            source: "paseo-daemon",
            projet: scope.projet,
            discussionId: agentId,
          });
        } catch (err) {
          logger.debug({ err, agentId }, "brain: exchange capture failed");
        }
      })();
    },
    { agentId, replayState: false },
  );
}

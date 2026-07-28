import type { InterruptedAgent } from "@/stores/daemon-restart-store";

/**
 * What to say to an agent whose turn a daemon restart cut short.
 *
 * Deliberately NOT a replay of the original prompt. Re-sending "commit and push"
 * verbatim to an agent that had already committed is how you get the work done
 * twice — and the agent has no way to know a restart happened, so it would
 * simply obey. The resume instead tells it what occurred and asks it to look
 * before it leaps; the conversation is still there, so it can see its own
 * earlier work.
 *
 * The objective comes from the agent's own synthesis, so the message names the
 * job rather than waving at it. Without one, the agent is asked to re-read its
 * own thread instead.
 */
export function buildRestartResumePrompt(agent: InterruptedAgent): string {
  const objective = agent.objective?.trim();
  const context = objective
    ? `Ton objectif en cours était : « ${objective} ».`
    : "Relis le fil de la conversation pour retrouver ce qui était demandé.";
  return [
    "Le moteur Paseo a redémarré pendant que tu travaillais : ton tour a été interrompu.",
    context,
    "Avant de continuer, vérifie ce qui a DÉJÀ été fait (fichiers modifiés, commits, commandes lancées) —",
    "ne refais pas une étape déjà terminée. Puis reprends là où tu t'es arrêté.",
  ].join(" ");
}

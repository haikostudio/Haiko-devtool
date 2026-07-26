import type { PaseoDeployAgentLaunchInput } from "./paseo-deploy.js";

/**
 * Marching orders for the agent that carries out a publication.
 *
 * Deliberately narrow: the agent does NOT invent a build, does not touch the
 * app's code to make a broken build pass, and does not restart the engine. It
 * runs the one script that publishes, watches it, checks the live marker
 * afterwards, and — this is the whole reason an agent is here rather than a bare
 * `spawn` — fixes the boring environment problems (stale install, leftover lock,
 * no disk space) and retries once instead of leaving a dead progress bar.
 *
 * Kept out of bootstrap so the wording is reviewable on its own.
 */
export function buildPaseoDeployAgentPrompt(input: PaseoDeployAgentLaunchInput): string {
  const branchNote =
    input.mergedBranches.length > 0
      ? `Ateliers déjà fusionnés dans ce dépôt pour cette publication : ${input.mergedBranches.join(", ")}.`
      : "Aucun atelier à fusionner : tu publies l'état actuel du dépôt.";

  return [
    "Tu es l'agent de publication de Paseo. L'utilisateur vient de cliquer sur « Publier » dans la fenêtre « À déployer ». Ton travail : mettre la version actuelle du dépôt en ligne, et ne rendre la main que quand c'est réellement fait — ou réellement impossible.",
    "",
    `Dépôt de publication : ${input.repoRoot} (tu y es déjà).`,
    `Script de publication : ${input.shipScript} — c'est LUI qui construit et publie. Ne réinvente pas la construction à la main.`,
    `Journal : ${input.logFile}`,
    `Fichier d'étape : ${input.phaseFile} (le script y écrit save → build → publish → done, ou error).`,
    branchNote,
    "",
    "Marche à suivre :",
    `1. Lance le script en arrière-plan pour ne pas être coupé par un délai d'attente : nohup ${input.shipScript} >> ${input.logFile} 2>&1 &`,
    `2. Surveille sans interrompre : toutes les 30 secondes environ, lis ${input.phaseFile} et la fin du journal (tail -n 40). Attends que le processus se termine.`,
    "3. Quand le script s'est arrêté, vérifie la vérité plutôt que l'impression : compare le contenu de /var/www/paseo-app/.deployed-sha avec `git rev-parse HEAD`. Identiques = la nouvelle version est bien servie.",
    "4. Si ce n'est pas en ligne, lis les lignes commençant par « !! » dans le journal. Si la cause est d'environnement (dépendances à réinstaller, place disque, verrou resté en place, fichier généré à régénérer), corrige-la et relance le script UNE seule fois.",
    "5. Termine par une ou deux phrases : ce qui est en ligne, ou ce qui a empêché la publication.",
    "",
    "Règles :",
    "- Ne modifie jamais le code de l'application pour faire passer la construction. Si le code est cassé, la publication échoue et tu le dis clairement.",
    "- Ne redémarre pas le moteur (aucun systemctl restart paseo), ne touche pas aux agents en cours.",
    "- Pas de git push, pas de merge, pas de changement de branche : ce qui devait être fusionné l'a déjà été avant ton lancement.",
    "- Si après une relance ce n'est toujours pas en ligne, arrête-toi et explique la cause. Ne prétends jamais avoir publié sans avoir vu les deux identifiants concorder.",
  ].join("\n");
}

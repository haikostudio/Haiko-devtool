import type { TaskUsage } from "@getpaseo/protocol/tasks/types";

/**
 * Mise en forme du compteur de consommation d'une carte.
 *
 * Deux lectures, volontairement séparées :
 *  - la carte n'affiche qu'un chiffre rond (« 128k jetons ») — elle doit rester
 *    lisible d'un coup d'œil ;
 *  - le détail affiche l'écart entre entrée, sortie et cache, parce que c'est là
 *    que se juge un réglage : réduire le contexte agit sur l'entrée, brider la
 *    longueur des réponses agit sur la sortie.
 *
 * Les jetons mis en cache ne sont PAS additionnés au total : ils sont déjà
 * comptés dans l'entrée par les fournisseurs, et les compter deux fois ferait
 * croire à une explosion de consommation là où il y a, au contraire, une
 * économie.
 */

/** Somme facturable d'un compteur : entrée + sortie, sans le cache. */
export function totalTaskTokens(usage: TaskUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * Chiffre court et rond : « 940 », « 12,4k », « 1,2M ». Sous mille on garde
 * l'unité exacte — arrondir 940 à « 0,9k » perdrait le seul cas où le détail
 * compte encore.
 */
export function formatTokenCount(tokens: number): string {
  const safe = Math.max(0, Math.round(tokens));
  if (safe < 1_000) {
    return String(safe);
  }
  if (safe < 1_000_000) {
    return `${trimZero(safe / 1_000)}k`;
  }
  return `${trimZero(safe / 1_000_000)}M`;
}

function trimZero(value: number): string {
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return String(rounded).replace(".", ",");
}

/** Vrai quand le compteur mérite d'être montré (une carte jamais lancée = rien). */
export function hasTaskUsage(usage: TaskUsage | null | undefined): usage is TaskUsage {
  return Boolean(usage && totalTaskTokens(usage) > 0);
}

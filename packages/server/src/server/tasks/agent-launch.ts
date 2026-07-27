import { z } from "zod";
import type { KanbanTask, TaskFolder } from "@getpaseo/protocol/tasks/types";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { buildAgentPrompt } from "../agent/prompt-attachments.js";

// Label stamped on every agent Paseo spawns for a task, so task agents are
// identifiable across the daemon (and excluded from Cerveau self-recursion).
export const TASK_AGENT_LABEL = "paseo.task-id";

// Structured estimate the analysis agent emits (as a trailing ```json block).
// Same shape the board consumes, minus the model/timestamp the caller stamps.
//
// Two INDEPENDENT time dimensions live here and must never be conflated:
//  - estimatedMinutes: the AGENT's own wall-clock runtime (fast — usually a few
//    minutes). This is what the card shows and what the scheduler uses to decide
//    light-vs-heavy timing.
//  - billingHours: the human effort a senior developer would bill doing the same
//    work BY HAND (the real price), used only by the Facturation tab.
export const TaskAnalysisEstimateSchema = z.object({
  // Estimated total token cost (input + output) for THIS task on its target model.
  tokens: z.number().int().nonnegative(),
  // Estimated share of one 5h usage window of the task's target model, 0-100.
  quotaPercent: z.number().min(0).max(100),
  // The agent's own active runtime in minutes — machine time, not human effort.
  estimatedMinutes: z.number().int().nonnegative(),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  // Billing lens for the Facturation tab. Optional so an agent that omits them
  // (or an older prompt) still parses; the UI falls back to the task's own
  // title/description and an empty hours field.
  //  - billingTitle: short invoice label (<= 5 words).
  //  - billingDescription: short invoice description (<= 3 lines).
  //  - billingHours: hours a senior developer would bill doing this BY HAND
  //    (real price), NOT the agent's runtime.
  billingTitle: z.string().optional(),
  billingDescription: z.string().optional(),
  billingHours: z.number().nonnegative().optional(),
});
export type TaskAnalysisEstimate = z.infer<typeof TaskAnalysisEstimateSchema>;

// Applied when the analysis agent fails or omits a parseable estimate, so a
// pipeline task never sits in pending_estimate forever. estimatedMinutes is the
// AGENT's own runtime, so the fallback is a short, realistic value (not a flat
// human-scale hour): it reads as a "light" task, so unknown work is governed by
// the quota gate — running promptly when quota allows — instead of being blindly
// parked until quiet hours. quotaPercent stays deliberately modest for the same
// reason; the scheduler's quota gate is the real safety governor.
export const ANALYSIS_FALLBACK_ESTIMATE: TaskAnalysisEstimate = {
  tokens: 200_000,
  quotaPercent: 10,
  estimatedMinutes: 15,
  confidence: "low",
  summary: "Estimation automatique indisponible — valeur par défaut prudente.",
};

// Conservative human-effort floor for the Facturation tab when the analysis
// agent omits billingHours. A non-zero seed matters: the invoice line only
// computes an amount (and becomes addable) once hours > 0, so an empty field
// reads as "no billing data". One hour is a safe, obviously-editable starting
// point the user tweaks before adding the line.
export const DEFAULT_BILLING_HOURS = 1;

// Invoice title stays short (<= 5 words); mirrors the Facturation tab's own
// trimming so the persisted seed matches what the UI would derive.
function toInvoiceTitle(source: string): string {
  return source.trim().split(/\s+/).slice(0, 5).join(" ");
}

// Invoice description stays short (<= 3 lines).
function toInvoiceDescription(source: string): string {
  return source.trim().split(/\r?\n/).slice(0, 3).join("\n");
}

/**
 * Guarantees the Facturation tab is never blank. The analysis agent is asked to
 * emit billingTitle/Description/Hours, but they're optional — a distracted agent
 * (or the fallback estimate) can omit them, leaving the tab empty (especially
 * the hours field, which has no client-side fallback and gates the amount). This
 * backfills any missing billing field from the task itself before the estimate
 * is persisted, so opening the tab always shows an editable, pre-filled line.
 *
 * Called only when a task enters analysis (Validé/Planifié), so the inert
 * backlog is never touched. Values only SEED the editable fields — the user
 * still tweaks them before adding the line.
 */
export function withBillingDefaults(
  estimate: TaskAnalysisEstimate,
  task: KanbanTask,
): TaskAnalysisEstimate {
  const description = task.description?.trim() ? toInvoiceDescription(task.description) : "";
  const title = estimate.billingTitle?.trim() || toInvoiceTitle(task.title);
  return {
    ...estimate,
    billingTitle: title,
    // Fall back to the task's own description, then to the invoice title, so the
    // line is never blank.
    billingDescription: estimate.billingDescription?.trim() || description || title,
    billingHours:
      estimate.billingHours != null && estimate.billingHours > 0
        ? estimate.billingHours
        : DEFAULT_BILLING_HOURS,
  };
}

// Turns free-form text into the branch-safe slug portion of a git ref: lowercase,
// accents stripped, non-alphanumerics collapsed to single dashes, trimmed. Shared
// by task-branch naming and folder-branch derivation.
export function slugifyBranch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-+)|(-+$)/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// Branch (and worktree slug) for a task launch: stable, readable, unique via a
// short task-id suffix so two similarly-titled tasks never collide.
export function taskBranchName(task: KanbanTask): string {
  const slug = slugifyBranch(task.title);
  const suffix = task.id.slice(0, 6);
  return slug ? `task/${slug}-${suffix}` : `task/${suffix}`;
}

export interface ResolvedTaskLaunch {
  /** provider or provider/model string passed to createAgent. */
  provider: string;
  /** Bare provider id (no model), e.g. "claude" | "codex". */
  providerId: string;
  planMode: boolean;
  /**
   * Maximally-permissive run mode for the provider (task agents run unattended
   * and must never block on a permission prompt). Plan-mode keeps "plan".
   */
  launchMode: string;
  /** Worktree branch for direct-mode runs; null for plan-mode (runs in place). */
  branchName: string | null;
}

/**
 * Resolves the launch parameters shared by the analysis and execution phases
 * from a task's runConfig, so both phases spawn/reuse the SAME kind of agent.
 */
export function resolveTaskLaunch(task: KanbanTask): ResolvedTaskLaunch {
  const runConfig = task.runConfig ?? undefined;
  const planMode = runConfig?.mode === "plan";
  const providerId = runConfig?.provider ?? "claude";
  let provider = "claude";
  if (runConfig) {
    provider = runConfig.model ? `${runConfig.provider}/${runConfig.model}` : runConfig.provider;
  }
  let launchMode = "bypassPermissions";
  if (planMode) {
    launchMode = "plan";
  } else if (providerId === "codex") {
    launchMode = "full-access";
  }
  const branchName = planMode ? null : taskBranchName(task);
  return { provider, providerId, planMode, launchMode, branchName };
}

/**
 * How a task's agent should get its working tree.
 *
 * Every task now runs IN PLACE, on the project's main branch. Cutting a branch
 * (and a worktree) per task produced exactly the problems it was meant to avoid:
 * conflicts between branches, painful merges, agents working from divergent
 * contexts, and a deploy step that had to reconcile all of it. One branch, one
 * context, one deploy.
 *
 * The "create"/"reuse" shapes are kept because older boards may still carry a
 * folder branch and its worktree; nothing produces them any more.
 */
export type TaskWorktreePlan =
  | { kind: "in-place"; branch: null }
  // First task of a branch-folder (or a legacy task): cut a fresh worktree.
  // recordFolderId set => stamp the resulting workspace back on that folder.
  | { kind: "create"; branchName: string; branch: string; recordFolderId: string | null }
  // Later task of a branch-folder: run inside the folder's shared worktree.
  | { kind: "reuse"; branch: string; workspaceId: string; cwd: string };

export function resolveTaskWorktreePlan(_input: {
  task: KanbanTask;
  folder: TaskFolder | undefined;
  planMode: boolean;
}): TaskWorktreePlan {
  // Always in place, on the project's main branch — see the note above.
  return { kind: "in-place", branch: null };
}

/**
 * Extracts the structured estimate from the analysis agent's final message.
 * The agent writes readable prose then a trailing ```json block; we parse the
 * last fenced block (falling back to any brace-delimited object) and validate
 * it. Returns null when nothing parseable is present.
 */
export function parseTaskAnalysisEstimate(text: string): TaskAnalysisEstimate | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map(
    (match) => match[1] ?? "",
  );
  const candidates = fenced.length > 0 ? fenced.toReversed() : [];
  for (const candidate of candidates) {
    const parsed = tryParseEstimate(candidate);
    if (parsed) {
      return parsed;
    }
  }
  // No fenced block matched: try the whole text, then any {...} substring.
  const whole = tryParseEstimate(text);
  if (whole) {
    return whole;
  }
  const brace = text.match(/\{[\s\S]*\}/);
  return brace ? tryParseEstimate(brace[0]) : null;
}

function tryParseEstimate(raw: string): TaskAnalysisEstimate | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const result = TaskAnalysisEstimateSchema.safeParse(JSON.parse(trimmed));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function taskHeader(task: KanbanTask): string[] {
  return [
    "## Tâche",
    `Titre : ${task.title}`,
    task.description ? `Description :\n${task.description}` : "",
    task.tags.length > 0 ? `Tags : ${task.tags.join(", ")}` : "",
  ];
}

/**
 * Phase 1 prompt. The visible task agent explores read-only, writes a readable
 * analysis into the chat, and ends with a ```json estimate block. It makes no
 * changes — execution resumes as a second turn in the SAME conversation.
 */
export function buildTaskAnalysisPrompt(input: {
  task: KanbanTask;
  planMode: boolean;
  branch: string | null;
}): string {
  const { task, planMode } = input;
  const providerLabel = resolveTaskLaunch(task).provider;
  const intro = planMode
    ? "Tu démarres une tâche du gestionnaire de tâches Paseo. L'exécution se fera directement dans le workspace en cours du projet."
    : "Tu démarres une tâche du gestionnaire de tâches Paseo. L'exécution se fera dans le checkout principal du projet, sur sa branche principale — comme toutes les autres tâches. Aucune branche dédiée n'est créée.";
  return [
    intro,
    `Agent d'exécution : ${providerLabel}. Chiffre tokens/quota/temps POUR CE modèle.`,
    "",
    ...taskHeader(task),
    "",
    "## Étape 1 — Analyse (maintenant, avant toute modification)",
    "Explore le dépôt en LECTURE SEULE (quelques fichiers au plus) pour cerner le périmètre.",
    "NE MODIFIE AUCUN fichier à cette étape. L'exécution reprendra ensuite dans CETTE MÊME conversation.",
    "",
    "## Format imposé de la réponse",
    "Réponds TOUJOURS avec EXACTEMENT ces quatre sections numérotées, dans cet ordre, chacune avec son titre puis son contenu :",
    "",
    "### 1. Objectif",
    "En une ou deux phrases : ce que la tâche doit accomplir, du point de vue du résultat.",
    "",
    "### 2. Approche retenue",
    "Le plan d'action en texte clair, étapes ordonnées. Reste concis et concret.",
    "",
    "### 3. Fichiers concernés & points de vigilance",
    "Présente-les sous forme de TABLEAU Markdown à deux colonnes : | Élément | Détail |.",
    "Une ligne par fichier touché et une ligne par point de vigilance (risque, dépendance, test).",
    "",
    "### 4. Estimation",
    "Termine impérativement cette section par un bloc ```json (et rien après) avec l'objet d'estimation :",
    '   {"tokens": <entier>, "quotaPercent": <0-100>, "estimatedMinutes": <entier>, "confidence": "low|medium|high", "summary": "<justification en une phrase>", "billingTitle": "<titre facturation, 5 mots max>", "billingDescription": "<description facturation, 3 lignes max>", "billingHours": <heures>}',
    `   • estimatedMinutes : le temps que TOI, l'agent (${providerLabel}), mettras réellement à EXÉCUTER la tâche, montre en main — en général quelques minutes (2 à 15), rarement plus de 30 même pour un gros chantier. C'est ce temps MACHINE qui s'affiche sur la carte. Ce n'est PAS l'effort humain (voir billingHours).`,
    `   • quotaPercent : part d'UNE fenêtre d'usage de 5 h de ${providerLabel} que cette exécution consommera (petite tâche ~2-10 %, gros chantier 30 %+). Un modèle plus lourd consomme plus de quota à travail égal.`,
    "   • tokens : coût total estimé en tokens (entrée + sortie).",
    "   • billingTitle : libellé court et clair pour une facture client (5 mots maximum).",
    "   • billingDescription : description concise du livrable pour la facture (3 lignes maximum, sans jargon).",
    "   • billingHours : nombre d'heures qu'un développeur senior facturerait pour réaliser ce travail À LA MAIN (prix réel, décimales autorisées). Ce n'est PAS ton temps d'exécution d'agent (estimatedMinutes), mais l'effort humain équivalent.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Phase 2 prompt. Sent to the SAME agent that ran the analysis (or, on the
 * legacy path, to a freshly-created agent), so it stays self-contained: it
 * restates the task and asks for the actual implementation (or full plan).
 */
export function buildTaskExecutionPrompt(input: {
  task: KanbanTask;
  planMode: boolean;
  branch: string | null;
}): string {
  const { task, planMode } = input;
  const intro = planMode
    ? "Tu exécutes une tâche du gestionnaire de tâches Paseo directement dans le workspace en cours du projet."
    : "Tu exécutes une tâche du gestionnaire de tâches Paseo dans le checkout principal du projet, sur sa branche principale. Toutes les tâches travaillent sur cette même branche : ne crée aucune branche, ne change pas de branche.";
  const instructions = planMode
    ? [
        "## Étape 2 — Plan d'implémentation",
        "1. Analyse la tâche et le dépôt, puis produis un PLAN D'IMPLÉMENTATION détaillé et actionnable :",
        "   fichiers à modifier, approche retenue, étapes ordonnées, risques, tests à écrire.",
        "2. NE modifie AUCUN fichier, ne commite pas, ne pousse pas.",
        "3. Termine ta réponse par le plan complet en Markdown — l'utilisateur reprendra",
        "   la main dans cette conversation pour décider de l'exécution.",
      ]
    : [
        "## Étape 2 — Exécution",
        "1. Implémente la tâche complètement dans ce dépôt, en respectant ses conventions.",
        "2. Vérifie ton travail (typecheck, lint, tests ciblés pertinents s'ils existent).",
        "3. Commite tes changements sur cette branche avec un message conventionnel clair.",
        "4. NE pousse PAS et NE crée PAS de pull request : l'utilisateur relit la branche et merge lui-même.",
        "5. Termine ta réponse par un résumé de ce que tu as fait et la liste des fichiers modifiés.",
      ];
  return [intro, "", ...taskHeader(task), "", ...instructions]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Fold any files/context the user attached when composing the task into the
 * agent prompt, as content blocks — the same shape a chat message carries. When
 * the task has no attachments this is a no-op (returns the plain text), so the
 * common path is unchanged. Called once at analysis time (and on the legacy
 * execution path); since analysis and execution share one conversation, the
 * agent keeps the attachments in context for the execution turn.
 */
export function withTaskAttachments(prompt: string, task: KanbanTask): AgentPromptInput {
  const attachments = task.attachments;
  if (!attachments || attachments.length === 0) {
    return prompt;
  }
  return buildAgentPrompt(prompt, undefined, attachments);
}

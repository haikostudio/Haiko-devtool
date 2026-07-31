import { z } from "zod";
import { AgentAttachmentSchema } from "../attachments.js";

// Kanban task board — per-project task management.
// Wire schemas are pure structural declarations (no transforms/defaults on containers).

// "notes": leftmost, pre-"backlog" draft column. Free-form capture — short notes
// carrying a deadline and an importance (stored as tags), no estimate and no
// agent. Nothing runs until the user drags a note into "backlog" (the normal
// cycle). It is NOT a pipeline column, so the scheduler never touches it.
// "validated": user-validated tasks. This is the consent gate — analysis
// (estimation) and execution only ever start here, never from "backlog".
// "deployed": post-"done" publication QUEUE. A task lands here once it is
// finished and waits for the batch publication; being here means "queued", not
// "live".
// "archived": terminal resting column at the very end of the cycle. A card
// reaches it AUTOMATICALLY the moment its work actually goes live (see
// TaskBoardService.markTaskDeployed), so the "À déployer" queue only ever shows
// what still needs publishing. It is read-only: nothing runs, re-deploys or
// re-analyses from here — archived cards are frozen, only consulted.
// Appending new values keeps the wire enum backward-compatible: an old daemon
// simply never emits it, and an old client that receives it is one release away.
export const TaskColumnSchema = z.enum([
  "backlog",
  "validated",
  "scheduled",
  "in_progress",
  "done",
  "deployed",
  "notes",
  "archived",
]);
export type TaskColumn = z.infer<typeof TaskColumnSchema>;

export const TaskEstimateSchema = z.object({
  tokens: z.number().int().nonnegative(),
  // Estimated share of one Claude 5h usage window, 0-100.
  quotaPercent: z.number().min(0).max(100),
  confidence: z.enum(["low", "medium", "high"]),
  model: z.string(),
  estimatedAt: z.string(),
  summary: z.string().optional(),
  // Estimated active agent runtime in minutes.
  estimatedMinutes: z.number().int().nonnegative().optional(),
  // Billing lens, produced by the analysis agent for the Facturation tab.
  // These describe the human deliverable, not the agent run:
  //  - billingTitle: short invoice label (<= 5 words).
  //  - billingDescription: short invoice description (<= 3 lines).
  //  - billingHours: effort a senior developer would bill by hand (real price,
  //    NOT the agent's runtime), in hours (decimals allowed).
  billingTitle: z.string().optional(),
  billingDescription: z.string().optional(),
  billingHours: z.number().nonnegative().optional(),
});
export type TaskEstimate = z.infer<typeof TaskEstimateSchema>;

// Records that a completed task's line was added to a billing document, so the
// UI can flag it as already billed and avoid accidental double-entry. Optional
// on the task; absent = not yet billed.
export const TaskBillingSchema = z.object({
  kind: z.enum(["quote", "invoice"]),
  documentId: z.string(),
  // Human document number (e.g. "FA-2026-001"), for the "already billed" badge.
  number: z.string(),
  addedAt: z.string(),
});
export type TaskBilling = z.infer<typeof TaskBillingSchema>;

// Per-task execution configuration chosen by the user or a proposing agent.
export const TaskRunConfigSchema = z.object({
  // Agent provider id, e.g. "claude", "codex".
  provider: z.string().min(1),
  // Provider model id, e.g. "claude-opus-4-8", "gpt-5.4". Absent = provider default.
  model: z.string().optional(),
  // Provider thinking/effort option id, e.g. "low" | "medium" | "high" | "xhigh" | "max".
  thinkingOptionId: z.string().optional(),
  // "plan": the agent produces an implementation plan and stops (no PR). Absent = "direct".
  mode: z.enum(["direct", "plan"]).optional(),
});
export type TaskRunConfig = z.infer<typeof TaskRunConfigSchema>;

// Approval gate for agent-proposed tasks. Absent approval = approved (legacy tasks).
export const TaskApprovalSchema = z.object({
  state: z.enum(["pending", "approved"]),
  // Agent that proposed the task (kept out of links to avoid agent-sync transitions).
  requestedBy: z.string().optional(),
  approvedAt: z.string().nullable().optional(),
});
export type TaskApproval = z.infer<typeof TaskApprovalSchema>;

// Launch timing preference. "auto": light tasks run anytime, heavy ones wait for
// quiet hours. "asap": ignore quiet hours. "off_peak": always wait for quiet hours.
export const TaskSchedulePreferenceSchema = z.enum(["auto", "asap", "off_peak"]);
export type TaskSchedulePreference = z.infer<typeof TaskSchedulePreferenceSchema>;

export const TaskScheduleStateSchema = z.object({
  state: z.enum(["pending_estimate", "awaiting_slot", "launching", "running", "failed"]),
  attempts: z.number().int().nonnegative(),
  // How many times an interrupted (canceled) run was auto-re-queued. Kept
  // separate from `attempts` so a daemon restart / manual stop doesn't burn a
  // real execution attempt and prematurely mark the task "failed".
  cancelRequeues: z.number().int().nonnegative().optional(),
  lastError: z.string().nullable().optional(),
  lastAttemptAt: z.string().optional(),
  // Why an awaiting_slot task is not launching yet (display-only refinement; a new
  // enum value in `state` would break old daemons parsing persisted boards).
  waitingReason: z.enum(["quota", "quiet_hours"]).optional(),
  // The OTHER two reasons a queued card is held back: a sibling task holds the
  // shared worktree, or every launch slot is taken. Carried in its own field
  // rather than as two more `waitingReason` literals, because an old client's
  // enum would reject the unknown value and fail the whole board message.
  // COMPAT(scheduleWaitingBlocker): added in v0.2.3, fold into `waitingReason`
  // once the floor is past it (target 2027-01-31).
  waitingBlocker: z.enum(["shared_worktree", "slots_busy"]).optional(),
});
export type TaskScheduleState = z.infer<typeof TaskScheduleStateSchema>;

/**
 * A deep analysis that did NOT produce a usable estimate.
 *
 * Recording the failure is the whole point. Writing a default estimate instead
 * looked harmless but was a permanent dead end: the estimator skips any task
 * that already has an estimate, so a card whose analysis crashed once could
 * never be analyzed again — it kept a made-up cost, fake billing data, and no
 * agent, forever, across restarts. A failure state keeps the door open.
 */
export const TaskAnalysisStateSchema = z.object({
  state: z.literal("failed"),
  attempts: z.number().int().nonnegative(),
  // Plain-language reason, shown on the card. Not a stack trace.
  reason: z.string().nullable().optional(),
  failedAt: z.string(),
  // True once the automatic retries are spent: the card then waits for the user
  // to ask for another attempt rather than looping on its own.
  exhausted: z.boolean().optional(),
});
export type TaskAnalysisState = z.infer<typeof TaskAnalysisStateSchema>;

export const TaskLinksSchema = z.object({
  agentIds: z.array(z.string()),
  primaryAgentId: z.string().nullable().optional(),
  // The pipeline agent Paseo spawned for this task: analysis and execution are
  // the SAME conversation. Distinct from primaryAgentId, which agent-sync may
  // point at a proposing/interactive agent. Absent for legacy tasks; when set,
  // the scheduler reuses this agent for execution instead of creating a new one.
  taskAgentId: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  prUrl: z.string().nullable().optional(),
  prState: z.enum(["open", "merged", "closed"]).nullable().optional(),
});
export type TaskLinks = z.infer<typeof TaskLinksSchema>;

// Outcome of the final check that runs when the user presses "Valider la tâche".
// The check is what actually moves a card to "Terminée": it re-reads the original
// request, exercises the work, runs the project's tests and looks for
// regressions. A failed check leaves the card in "En cours" with the report
// below, so the user can read exactly what to fix before trying again.
export const TaskValidationSchema = z.object({
  state: z.enum(["running", "passed", "failed"]),
  // Human-readable report, shown next to the "Valider la tâche" bar. On a failure
  // it lists what is missing or broken.
  report: z.string().optional(),
  // Short one-line verdict, for a toast or a card badge.
  summary: z.string().optional(),
  checkedAt: z.string().optional(),
});
export type TaskValidation = z.infer<typeof TaskValidationSchema>;

// Consent window + outcome for the deploy action behind "Lancer le déploiement".
// Symmetric to TaskValidationSchema: pressing the deploy bar on a finished ("done")
// card opens a "running" window that is the user's consent for the card's own
// agent to move it to "deployed" once the deployment is verified live. The window
// stays open across pauses and questions, and closes only on a verified outcome.
export const TaskDeploymentSchema = z.object({
  state: z.enum(["running", "deployed", "failed"]),
  // Human-readable report shown next to the deploy bar (what was deployed, where).
  report: z.string().optional(),
  // Short one-line verdict, for a toast or a card badge.
  summary: z.string().optional(),
  startedAt: z.string().optional(),
});
export type TaskDeployment = z.infer<typeof TaskDeploymentSchema>;

/**
 * Consommation modèle cumulée d'une carte : additionnée à chaque tour de chaque
 * agent qui lui est rattaché, et conservée même après l'archivage de l'agent.
 *
 * Tous les champs sont des compteurs simples, jamais nuls une fois écrits. Le
 * coût est en dollars parce que c'est l'unité que les fournisseurs rapportent ;
 * la conversion en francs, elle, appartient à la facturation.
 */
export const TaskUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  turns: z.number().int().nonnegative(),
  /** Dernier tour comptabilisé, pour dater le compteur sur la carte. */
  updatedAt: z.string(),
});
export type TaskUsage = z.infer<typeof TaskUsageSchema>;

export const KanbanTaskSchema = z.object({
  id: z.string(),
  folderId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  // Files/context the user attached when composing the task's prompt. Persisted
  // so the pipeline agent receives them (as prompt content blocks) when the task
  // is later analyzed/executed — the same attachment shape as a chat message.
  // Optional + additive: old boards/clients simply omit it.
  attachments: z.array(AgentAttachmentSchema).optional(),
  column: TaskColumnSchema,
  order: z.number().int(),
  origin: z.enum(["manual", "agent_sync"]),
  // Dedupe key for agent-sync: lowercase, trimmed, bullets/punctuation stripped.
  normalizedTitle: z.string(),
  // Light analysis (backlog only): a cheap Haiku pass that turns a raw pasted
  // prompt into a clear title + tidied description. "pending" while the refiner
  // runs, "done" once it lands (or absent when never needed). It NEVER produces
  // a cost/billing/schedule — that is the deep analysis that only fires at
  // "Validé". Additive + optional: old boards/clients simply omit it.
  refinement: z.enum(["pending", "done"]).nullable().optional(),
  // Outcome of the DEEP analysis (the "Validé" pass that produces the estimate
  // and the billing data). Only ever set on failure: it is what stops a failed
  // analysis from being silently papered over with a default estimate — the card
  // says so, and the user can ask for another attempt.
  // Additive + optional: old boards/clients simply omit it.
  analysis: TaskAnalysisStateSchema.nullable().optional(),
  estimate: TaskEstimateSchema.nullable().optional(),
  schedule: TaskScheduleStateSchema.nullable().optional(),
  runConfig: TaskRunConfigSchema.nullable().optional(),
  approval: TaskApprovalSchema.nullable().optional(),
  schedulePreference: TaskSchedulePreferenceSchema.optional(),
  // "Pause au choix": when true, the scheduler analyzes the task (so the plan +
  // estimate show up) but HOLDS execution until the user gives the go — an
  // explicit run-now, or clearing the hold. Absent/false = auto (the "Validé"
  // column consent still runs the task automatically once a slot opens).
  executionHold: z.boolean().optional(),
  // Set when a plan-mode run finished: the plan is ready in the linked agent.
  planReadyAt: z.string().nullable().optional(),
  // Sub-status of a task sitting in "En cours". A task NEVER leaves that column
  // on its own — not even when the agent stops talking — so this says where it
  // actually stands without moving the card:
  //  - "analyzing"/"executing": the agent is working;
  //  - "waiting": it is waiting on something (a command, an external answer);
  //  - "awaiting_user": it asked the user a question;
  //  - "blocked": it hit something it cannot get past;
  //  - "ready_for_review": it believes it is finished — the user still has to
  //    press "Valider la tâche" for the card to reach "Terminée".
  // Optional + additive: old boards/clients simply omit it.
  progress: z
    .enum(["analyzing", "executing", "waiting", "awaiting_user", "blocked", "ready_for_review"])
    .nullable()
    .optional(),
  links: TaskLinksSchema,
  // Set on user-initiated column moves; suppresses agent-sync transitions afterwards.
  manualOverrideAt: z.string().nullable().optional(),
  // Stamped the first time a task reaches "done". Makes "done" terminal: the
  // scheduler never re-arms or relaunches a completed task, even if it later
  // re-enters a pipeline column.
  completedAt: z.string().nullable().optional(),
  // Stamped when a task reaches "deployed" — the conductor confirmed the work
  // is live (merged + published). Terminal, like completedAt; a task entering
  // "deployed" also gets a completedAt if it somehow skipped "done".
  deployedAt: z.string().nullable().optional(),
  // Public address the finished card's work went live at — the project's dev
  // instance, or Paseo's own web app. Shown as a link on the card so a finished
  // task is one tap from the thing it changed. Additive + optional: cards
  // finished before this existed, or projects with no instance, simply omit it.
  deployedUrl: z.string().nullable().optional(),
  // Stamped the first time the user opens this card. Purely a "already seen"
  // marker: a finished (done/deployed) card that has been viewed dims to ~50%
  // opacity so it recedes behind still-unseen finished work. Deliberately never
  // touches updatedAt when set, so marking a card viewed never reorders it.
  // Optional + additive — old boards/clients simply omit it.
  viewedAt: z.string().nullable().optional(),
  // Stamped when the user archives a finished (done/deployed) card from the
  // "Archiver" bar. Archiving is orthogonal to the seven columns: it never moves
  // the card, never publishes it, and never disturbs the automatic done→deployed
  // publication — it only hides the card from the board (see
  // docs/task-board-cycle.md). Additive + optional: old boards/clients simply
  // omit it, and un-archiving clears it back to absent.
  archivedAt: z.string().nullable().optional(),
  // The column the card sat in just before it entered the terminal "archived"
  // column, so an accidental archive can be undone straight back to where it
  // came from ("Désarchiver"). Auto-archived cards (published → archived) record
  // "deployed"; a hand-filed card records whatever it was dragged from. Additive
  // + optional: old boards/clients omit it, and un-archiving clears it.
  preArchiveColumn: TaskColumnSchema.nullable().optional(),
  // Set once the task's line has been added to a billing document.
  billing: TaskBillingSchema.nullable().optional(),
  // Result of the final check behind "Valider la tâche". Additive + optional.
  validation: TaskValidationSchema.nullable().optional(),
  // Consent window + outcome of the "Lancer le déploiement" action, which moves a
  // finished card to "deployed" through its own agent. Additive + optional.
  deployment: TaskDeploymentSchema.nullable().optional(),
  // "Retirer du prochain lot": the card stays in "À déployer" but the batch
  // publication skips it. A pause, not an archive — the card is still visible,
  // still finished, simply held back until the user puts it back in. Additive +
  // optional: old boards/clients simply omit it.
  deployHold: z.boolean().optional(),
  // Set when the deployed work only takes effect after the daemon is restarted
  // (e.g. a server-side change). Purely informative: it is surfaced as an icon on
  // the card and NEVER triggers a restart on its own — that stays the user's call.
  // Additive + optional: old boards/clients simply omit it.
  needsDaemonRestart: z.boolean().optional(),
  // Set when the user started the final check with "Terminer et mettre en file":
  // the card is to be queued into "À déployer" the moment it completes, instead
  // of resting in "Terminé" for a second press. Consumed and cleared by the
  // completion listener, so it never survives the run it was armed for.
  // Additive + optional: old boards/clients simply omit it.
  queueOnComplete: z.boolean().optional(),
  // Exact version this card's work went online in, stamped by the publication
  // that shipped it. "Déployé" alone cannot answer "which build?" once a second
  // publication has followed. Additive + optional: old boards/clients omit it.
  deployedSha: z.string().nullable().optional(),
  // Ce que la carte a réellement coûté en modèle, cumulé sur tous ses agents et
  // tous ses tours. Sans ce compteur, « est-ce que ce réglage économise
  // vraiment ? » n'a pas de réponse chiffrée — seulement une impression.
  // Additif + optionnel : les anciens tableaux/clients l'omettent simplement.
  usage: TaskUsageSchema.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KanbanTask = z.infer<typeof KanbanTaskSchema>;

export const TaskFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Accent color for the folder card, hex string (e.g. "#f97316").
  color: z.string().optional(),
  // Launch policy for the folder's backlog. Tasks now start IMMEDIATELY by
  // default: the scheduler auto-validates a folder's backlog (quota + quiet-hours
  // gates still apply) unless the user opts into manual review. Set this true to
  // hold every task until the user explicitly validates it (drag to "Validé" /
  // run-now). Absent/false = immediate start (the default).
  requireValidation: z.boolean().optional(),
  // Legacy per-folder autopilot flag. Superseded by `requireValidation` (immediate
  // start is now the default, so an unset folder already auto-launches). Still
  // parsed for backward-compat with boards written before the inversion; new
  // clients stop sending it. COMPAT(taskFolderAutopilot): drop once no persisted
  // board relies on it (target 2027-01-24).
  autopilot: z.boolean().optional(),
  // A folder IS a real git branch: every task in it works and commits on this
  // branch, inside one shared worktree. Absent (legacy folders) = each task
  // falls back to its own throwaway `task/<slug>-<id>` branch.
  branch: z.string().optional(),
  // The shared worktree for this folder's branch, stamped on the first task
  // launch. Git allows only one worktree per branch, so tasks in the folder reuse
  // this workspace and run one at a time. Absent = not yet created.
  workspaceId: z.string().nullable().optional(),
  // Absolute path of that shared worktree, so later tasks spawn their agent
  // inside it (same branch). Stamped together with workspaceId.
  worktreeCwd: z.string().nullable().optional(),
  order: z.number().int(),
  createdAt: z.string(),
});
export type TaskFolder = z.infer<typeof TaskFolderSchema>;

// The last "Tout déployer" run of a project: what it is publishing, where it
// stands, and how it ended. It is what the column shows as a progress bar while
// the batch runs, and as a "voici ce qui vient d'être mis en ligne" recap once
// it is over. Titles are snapshotted so the recap still reads correctly if a
// card is renamed, archived or deleted afterwards.
export const TaskDeployBatchSchema = z.object({
  state: z.enum(["running", "success", "failed"]),
  // Visible step written by the publication flow: preparation → checks → engine
  // → site → online → optional restart. Kept as a string for older hosts.
  phase: z.string().nullable().optional(),
  startedAt: z.string(),
  finishedAt: z.string().nullable().optional(),
  taskIds: z.array(z.string()),
  titles: z.array(z.string()).optional(),
  // Address the batch went live at, when the project has one.
  url: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  // True when the off-peak option started this run instead of a user press.
  auto: z.boolean().optional(),
  // The single grouped deploy agent carrying out this run (Paseo self-host).
  // Lets the progress banner open its conversation so the build/publish can be
  // watched live. Absent on ordinary projects (deployed card-by-card) and on
  // older daemons that predate the field.
  agentId: z.string().nullable().optional(),
  // True while a SECOND publication is waiting for this one to finish. Publications
  // are serialized (one active at a time); a request arriving mid-run is queued
  // rather than run in parallel, and this flag is what the board shows as
  // "une publication en attente". Additive + optional: old daemons never set it.
  queued: z.boolean().optional(),
});
export type TaskDeployBatch = z.infer<typeof TaskDeployBatchSchema>;

// A task proposed to the user in chat (by the inline triage layer or the
// conductor's create_task). It carries the FULL payload so the task can be
// created ONLY once the user approves — while a proposal is merely on screen,
// nothing is written to the board. `proposalId` is the stable key that makes
// approval idempotent: approving the same proposal twice (double-tap, reload,
// two devices) yields exactly one task, never a duplicate.
export const TaskChatProposalSchema = z.object({
  proposalId: z.string().optional(),
  // Legacy: pre-deferred-creation pills pointed at an already-created board task.
  // New proposals never set it; kept so old in-flight pills still parse.
  taskId: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  folderName: z.string().optional(),
  runConfig: TaskRunConfigSchema.optional(),
});
export type TaskChatProposal = z.infer<typeof TaskChatProposalSchema>;

// The board's record of what happened to a proposal, so the chat tray stays
// honest across reloads and the resolve RPC stays idempotent. Approved carries
// the created task's id; refused carries nothing but the fact of refusal.
export const TaskProposalResolutionSchema = z.object({
  proposalId: z.string(),
  outcome: z.enum(["approved", "refused"]),
  taskId: z.string().optional(),
});
export type TaskProposalResolution = z.infer<typeof TaskProposalResolutionSchema>;

export const TaskBoardSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  folders: z.array(TaskFolderSchema),
  tasks: z.array(KanbanTaskSchema),
  // Proposals the user has already approved or refused. A proposal not listed
  // here is still awaiting a decision. Additive + optional: old boards and old
  // clients simply omit it. See TaskChatProposalSchema.
  proposalResolutions: z.array(TaskProposalResolutionSchema).optional(),
  // Last/current batch publication. Additive + optional: old boards and old
  // clients simply omit it, and a board that never published carries nothing.
  deployBatch: TaskDeployBatchSchema.nullable().optional(),
  // Stamped once, the first time a daemon carrying the publication QUEUE opens
  // this board. Before that change the last column meant "already deployed", so
  // every card sitting there was live; after it, the column is a waiting room.
  // Without this one-time marker those legacy cards would be read as "waiting to
  // be published" and the next batch would offer to re-publish the entire
  // history. Additive + optional.
  legacyDeployedBackfilledAt: z.string().nullable().optional(),
});
export type TaskBoard = z.infer<typeof TaskBoardSchema>;

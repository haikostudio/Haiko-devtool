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
// "deployed": terminal, post-"done" column. A task lands here once the
// conductor has confirmed its work is actually live (merged + published).
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
  // Set once the task's line has been added to a billing document.
  billing: TaskBillingSchema.nullable().optional(),
  // Result of the final check behind "Valider la tâche". Additive + optional.
  validation: TaskValidationSchema.nullable().optional(),
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

export const TaskBoardSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  folders: z.array(TaskFolderSchema),
  tasks: z.array(KanbanTaskSchema),
});
export type TaskBoard = z.infer<typeof TaskBoardSchema>;

import { z } from "zod";

// Kanban task board — per-project task management.
// Wire schemas are pure structural declarations (no transforms/defaults on containers).

// "validated": user-validated tasks. This is the consent gate — analysis
// (estimation) and execution only ever start here, never from "backlog".
export const TaskColumnSchema = z.enum([
  "backlog",
  "validated",
  "scheduled",
  "in_progress",
  "done",
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

// Set once the task's billable line was added to a compta quote/invoice from
// the Facturation tab. Informational only — the amounts live in the compta
// document; this lets the task show it is already billed and link back to it.
export const TaskBillingLinkSchema = z.object({
  kind: z.enum(["quote", "invoice"]),
  documentId: z.string(),
  // Human-facing document number, e.g. "FAC-0007" / "DEV-0003".
  documentNumber: z.string(),
  addedAt: z.string(),
});
export type TaskBillingLink = z.infer<typeof TaskBillingLinkSchema>;

export const KanbanTaskSchema = z.object({
  id: z.string(),
  folderId: z.string(),
  title: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()),
  column: TaskColumnSchema,
  order: z.number().int(),
  origin: z.enum(["manual", "agent_sync"]),
  // Dedupe key for agent-sync: lowercase, trimmed, bullets/punctuation stripped.
  normalizedTitle: z.string(),
  estimate: TaskEstimateSchema.nullable().optional(),
  schedule: TaskScheduleStateSchema.nullable().optional(),
  runConfig: TaskRunConfigSchema.nullable().optional(),
  approval: TaskApprovalSchema.nullable().optional(),
  schedulePreference: TaskSchedulePreferenceSchema.optional(),
  // Set once the task's line was added to a compta quote/invoice (Facturation tab).
  billing: TaskBillingLinkSchema.nullable().optional(),
  // Set when a plan-mode run finished: the plan is ready in the linked agent.
  planReadyAt: z.string().nullable().optional(),
  links: TaskLinksSchema,
  // Set on user-initiated column moves; suppresses agent-sync transitions afterwards.
  manualOverrideAt: z.string().nullable().optional(),
  // Stamped the first time a task reaches "done". Makes "done" terminal: the
  // scheduler never re-arms or relaunches a completed task, even if it later
  // re-enters a pipeline column.
  completedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KanbanTask = z.infer<typeof KanbanTaskSchema>;

export const TaskFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Accent color for the folder card, hex string (e.g. "#f97316").
  color: z.string().optional(),
  // Autopilot: the scheduler may pick this folder's backlog tasks directly
  // (quota + quiet-hours gates still apply). Absent = manual (drag to Planned).
  autopilot: z.boolean().optional(),
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

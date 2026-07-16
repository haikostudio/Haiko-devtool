import { z } from "zod";

// Kanban task board — per-project task management.
// Wire schemas are pure structural declarations (no transforms/defaults on containers).

export const TaskColumnSchema = z.enum(["backlog", "scheduled", "in_progress", "done"]);
export type TaskColumn = z.infer<typeof TaskColumnSchema>;

export const TaskEstimateSchema = z.object({
  tokens: z.number().int().nonnegative(),
  // Estimated share of one Claude 5h usage window, 0-100.
  quotaPercent: z.number().min(0).max(100),
  confidence: z.enum(["low", "medium", "high"]),
  model: z.string(),
  estimatedAt: z.string(),
  summary: z.string().optional(),
});
export type TaskEstimate = z.infer<typeof TaskEstimateSchema>;

export const TaskScheduleStateSchema = z.object({
  state: z.enum(["pending_estimate", "awaiting_slot", "launching", "running", "failed"]),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable().optional(),
  lastAttemptAt: z.string().optional(),
});
export type TaskScheduleState = z.infer<typeof TaskScheduleStateSchema>;

export const TaskLinksSchema = z.object({
  agentIds: z.array(z.string()),
  primaryAgentId: z.string().nullable().optional(),
  workspaceId: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  prUrl: z.string().nullable().optional(),
  prState: z.enum(["open", "merged", "closed"]).nullable().optional(),
});
export type TaskLinks = z.infer<typeof TaskLinksSchema>;

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
  links: TaskLinksSchema,
  // Set on user-initiated column moves; suppresses agent-sync transitions afterwards.
  manualOverrideAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type KanbanTask = z.infer<typeof KanbanTaskSchema>;

export const TaskFolderSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Accent color for the folder card, hex string (e.g. "#f97316").
  color: z.string().optional(),
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

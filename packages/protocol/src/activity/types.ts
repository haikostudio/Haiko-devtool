import { z } from "zod";

// Global activity log — a daemon-managed changelog of what agents have done.
// One entry per agent, upserted each time the agent finishes a turn; the title
// is the agent's latest synthesis summary. Purely additive on the wire.

export const ActivityLogEntrySchema = z.object({
  // Entry id — equal to the agent id (one line per agent).
  id: z.string(),
  agentId: z.string(),
  provider: z.string(),
  // Absolute working directory of the agent (the targeted project on disk).
  cwd: z.string(),
  // Workspace the agent belongs to, when known.
  workspaceId: z.string().nullable().optional(),
  // Human-readable project name resolved server-side (workspace/project title,
  // falling back to the cwd basename).
  projectName: z.string(),
  // Short synthesis of what this agent did (its latest turn summary).
  title: z.string(),
  // ISO timestamps. createdAt = first turn logged, updatedAt = last turn logged.
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ActivityLogEntry = z.infer<typeof ActivityLogEntrySchema>;

export const ActivityLogSchema = z.object({
  version: z.literal(1),
  entries: z.array(ActivityLogEntrySchema),
});

export type ActivityLog = z.infer<typeof ActivityLogSchema>;

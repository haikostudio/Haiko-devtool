import { z } from "zod";

// The structured estimate the task-analysis agent appends to its message as a
// trailing ```json block. It mirrors the server's TaskAnalysisEstimateSchema
// (packages/server/src/server/tasks/agent-launch.ts) — kept in sync by shape,
// not imported, since that module is server-only. We parse it on the client to
// render the estimate as a readable card (summary + numbers table) instead of
// showing the raw JSON block in the task chat.
export const TaskAnalysisEstimateSchema = z.object({
  tokens: z.number().int().nonnegative(),
  quotaPercent: z.number().min(0).max(100),
  estimatedMinutes: z.number().int().nonnegative(),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  billingTitle: z.string().optional(),
  billingDescription: z.string().optional(),
  billingHours: z.number().nonnegative().optional(),
});

export type TaskAnalysisEstimate = z.infer<typeof TaskAnalysisEstimateSchema>;

/**
 * Parses a fenced code block's raw text as a task-analysis estimate. Returns the
 * validated estimate, or null when the text isn't the estimate payload — the
 * caller then falls back to the normal code-block rendering. The guard is strict
 * (all core fields present and well-typed) so a stray JSON block from any other
 * agent never gets mistaken for an estimate. Returns null for partial JSON too,
 * so a mid-stream block renders as code until the estimate is complete.
 */
export function parseTaskAnalysisEstimateBlock(raw: string): TaskAnalysisEstimate | null {
  const trimmed = raw.trim();
  // Cheap pre-check: the payload is a JSON object mentioning quotaPercent. Skips
  // JSON.parse on the overwhelming majority of unrelated code blocks.
  if (!trimmed.startsWith("{") || !trimmed.includes("quotaPercent")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = TaskAnalysisEstimateSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

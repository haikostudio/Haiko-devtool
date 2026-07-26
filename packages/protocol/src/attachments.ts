import { z } from "zod";

// Attachment schemas shared across the protocol. These live in their own module
// (rather than messages.ts) so lower-level schemas — notably tasks — can carry
// attachments without importing messages.ts, which itself depends on the tasks
// RPC schemas (importing it back would form an eval-time import cycle).
//
// messages.ts re-exports everything here, so existing
// `@getpaseo/protocol/messages` imports keep working unchanged.

export const GitHubPrAttachmentSchema = z.object({
  type: z.literal("github_pr"),
  mimeType: z.literal("application/github-pr"),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable().optional(),
  baseRefName: z.string().nullable().optional(),
  headRefName: z.string().nullable().optional(),
});

export const GitHubIssueAttachmentSchema = z.object({
  type: z.literal("github_issue"),
  mimeType: z.literal("application/github-issue"),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable().optional(),
});

export const TextAttachmentSchema = z
  .object({
    type: z.literal("text"),
    mimeType: z.literal("text/plain"),
    contextKind: z.string().optional(),
    title: z.string().nullable().optional(),
    text: z.string(),
  })
  .transform(({ contextKind, ...attachment }) => ({
    ...attachment,
    ...(contextKind === "chat_history" ? { contextKind } : {}),
  }));

export const ReviewAttachmentContextLineSchema = z.object({
  oldLineNumber: z.number().int().positive().nullable(),
  newLineNumber: z.number().int().positive().nullable(),
  type: z.enum(["add", "remove", "context"]),
  content: z.string(),
});

export const ReviewAttachmentCommentSchema = z.object({
  filePath: z.string(),
  side: z.enum(["old", "new"]),
  lineNumber: z.number().int().positive(),
  body: z.string(),
  context: z.object({
    hunkHeader: z.string(),
    targetLine: ReviewAttachmentContextLineSchema,
    lines: z.array(ReviewAttachmentContextLineSchema),
  }),
});

export const ReviewAttachmentSchema = z.object({
  type: z.literal("review"),
  mimeType: z.literal("application/paseo-review"),
  cwd: z.string(),
  mode: z.enum(["uncommitted", "base"]),
  baseRef: z.string().nullable().optional(),
  comments: z.array(ReviewAttachmentCommentSchema),
});

export const UploadedFileAttachmentSchema = z.object({
  type: z.literal("uploaded_file"),
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  path: z.string(),
});

export const ForgeChangeRequestAttachmentSchema = z.object({
  type: z.literal("forge_change_request"),
  mimeType: z.literal("application/paseo-forge-change-request"),
  forge: z.string().optional().default("github"),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable().optional(),
  projectPath: z.string().optional(),
  baseRefName: z.string().nullable().optional(),
  headRefName: z.string().nullable().optional(),
});
export type ForgeChangeRequestAttachment = z.infer<typeof ForgeChangeRequestAttachmentSchema>;

export const ForgeIssueAttachmentSchema = z.object({
  type: z.literal("forge_issue"),
  mimeType: z.literal("application/paseo-forge-issue"),
  forge: z.string().optional().default("github"),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  body: z.string().nullable().optional(),
  projectPath: z.string().optional(),
});
export type ForgeIssueAttachment = z.infer<typeof ForgeIssueAttachmentSchema>;

export const AgentAttachmentSchema = z.discriminatedUnion("type", [
  ForgeChangeRequestAttachmentSchema,
  ForgeIssueAttachmentSchema,
  GitHubPrAttachmentSchema,
  GitHubIssueAttachmentSchema,
  TextAttachmentSchema,
  ReviewAttachmentSchema,
  UploadedFileAttachmentSchema,
]);

// One entry in a workspace's attachment library — a file or image that has
// transited through the chat of one of the workspace's agents. Built server-side
// from the send-time index (plus a lazy backfill of historical images), and
// returned to the client for the search drawer. Purely descriptive: the bytes
// live on disk (uploads or a materialized image blob), fetched on demand.
export const AttachmentLibraryEntrySchema = z.object({
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  /** When it was first seen in the chat (epoch ms). */
  addedAt: z.number(),
  kind: z.enum(["image", "file"]),
  /** Agent whose chat carried this attachment, for grouping in the drawer. */
  agentId: z.string().optional(),
  agentTitle: z.string().optional(),
  /** True when the daemon holds bytes it can preview/serve for this entry. */
  hasPreview: z.boolean().optional(),
});

export type AgentAttachment = z.infer<typeof AgentAttachmentSchema>;
export type UploadedFileAttachment = z.infer<typeof UploadedFileAttachmentSchema>;
export type ReviewAttachment = z.infer<typeof ReviewAttachmentSchema>;
export type AttachmentLibraryEntry = z.infer<typeof AttachmentLibraryEntrySchema>;

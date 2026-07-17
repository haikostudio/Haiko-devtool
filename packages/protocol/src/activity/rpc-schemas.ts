import { z } from "zod";
import { ActivityLogEntrySchema } from "./types.js";

// activity.* RPC namespace — dotted names with .request/.response suffixes
// (see docs/rpc-namespacing.md). The global activity log is a single, all-project
// stream; there is no per-project scoping like tasks.

export const ActivityLogGetRequestSchema = z.object({
  type: z.literal("activity.log.get.request"),
  requestId: z.string(),
});

export const ActivityLogSubscribeRequestSchema = z.object({
  type: z.literal("activity.log.subscribe.request"),
  requestId: z.string(),
  subscriptionId: z.string(),
});

export const ActivityLogUnsubscribeRequestSchema = z.object({
  type: z.literal("activity.log.unsubscribe.request"),
  requestId: z.string(),
  subscriptionId: z.string(),
});

export const ActivityLogGetResponseSchema = z.object({
  type: z.literal("activity.log.get.response"),
  payload: z.object({
    requestId: z.string(),
    entries: z.array(ActivityLogEntrySchema),
    error: z.string().nullable(),
  }),
});

export const ActivityLogSubscribeResponseSchema = z.object({
  type: z.literal("activity.log.subscribe.response"),
  payload: z.object({
    requestId: z.string(),
    entries: z.array(ActivityLogEntrySchema),
    error: z.string().nullable(),
  }),
});

export const ActivityLogUnsubscribeResponseSchema = z.object({
  type: z.literal("activity.log.unsubscribe.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

// Push event — sent to sessions holding an active subscription when an entry is
// upserted; no .response pair. The client merges the entry by agentId.
export const ActivityLogUpdateMessageSchema = z.object({
  type: z.literal("activity.log.update"),
  payload: z.object({
    subscriptionId: z.string(),
    entry: ActivityLogEntrySchema,
  }),
});

import { z } from "zod";
import {
  KanbanTaskSchema,
  TaskBillingSchema,
  TaskBoardSchema,
  TaskColumnSchema,
  TaskFolderSchema,
  TaskImageAttachmentSchema,
  TaskRunConfigSchema,
  TaskSchedulePreferenceSchema,
} from "./types.js";

// tasks.* RPC namespace — dotted names with .request/.response suffixes
// (see docs/rpc-namespacing.md).

export const TasksBoardGetRequestSchema = z.object({
  type: z.literal("tasks.board.get.request"),
  requestId: z.string(),
  projectId: z.string(),
});

export const TasksBoardSubscribeRequestSchema = z.object({
  type: z.literal("tasks.board.subscribe.request"),
  requestId: z.string(),
  projectId: z.string(),
  subscriptionId: z.string(),
});

export const TasksBoardUnsubscribeRequestSchema = z.object({
  type: z.literal("tasks.board.unsubscribe.request"),
  requestId: z.string(),
  subscriptionId: z.string(),
});

export const TasksFolderCreateRequestSchema = z.object({
  type: z.literal("tasks.folder.create.request"),
  requestId: z.string(),
  projectId: z.string(),
  name: z.string().min(1),
  color: z.string().optional(),
  autopilot: z.boolean().optional(),
  // Git branch this folder represents; derived from the name when omitted.
  branch: z.string().optional(),
});

export const TasksFolderUpdateRequestSchema = z.object({
  type: z.literal("tasks.folder.update.request"),
  requestId: z.string(),
  projectId: z.string(),
  folderId: z.string(),
  name: z.string().min(1).optional(),
  color: z.string().optional(),
  autopilot: z.boolean().optional(),
  branch: z.string().optional(),
  order: z.number().int().optional(),
});

export const TasksFolderDeleteRequestSchema = z.object({
  type: z.literal("tasks.folder.delete.request"),
  requestId: z.string(),
  projectId: z.string(),
  folderId: z.string(),
});

export const TasksTaskCreateRequestSchema = z.object({
  type: z.literal("tasks.task.create.request"),
  requestId: z.string(),
  projectId: z.string(),
  folderId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  column: TaskColumnSchema.optional(),
  runConfig: TaskRunConfigSchema.optional(),
  schedulePreference: TaskSchedulePreferenceSchema.optional(),
  // Pictures attached in the "add task" card, forwarded to the background agent.
  images: z.array(TaskImageAttachmentSchema).optional(),
});

export const TasksTaskUpdateRequestSchema = z.object({
  type: z.literal("tasks.task.update.request"),
  requestId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  title: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  // null clears the field.
  runConfig: TaskRunConfigSchema.nullable().optional(),
  schedulePreference: TaskSchedulePreferenceSchema.nullable().optional(),
  // Set when a task line is added to a billing document; null clears it.
  billing: TaskBillingSchema.nullable().optional(),
  // "Pause au choix": true holds execution after analysis until the user's go;
  // false/null returns the task to automatic execution.
  executionHold: z.boolean().nullable().optional(),
});

export const TasksTaskMoveRequestSchema = z.object({
  type: z.literal("tasks.task.move.request"),
  requestId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  column: TaskColumnSchema,
  index: z.number().int().nonnegative(),
});

export const TasksTaskDeleteRequestSchema = z.object({
  type: z.literal("tasks.task.delete.request"),
  requestId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
});

export const TasksTaskEstimateRequestSchema = z.object({
  type: z.literal("tasks.task.estimate.request"),
  requestId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
});

export const TasksTaskRunNowRequestSchema = z.object({
  type: z.literal("tasks.task.run_now.request"),
  requestId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
});

export const TasksTaskApproveRequestSchema = z.object({
  type: z.literal("tasks.task.approve.request"),
  requestId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
});

export const TasksConductorEnsureRequestSchema = z.object({
  type: z.literal("tasks.conductor.ensure.request"),
  requestId: z.string(),
  projectId: z.string(),
});

export const TasksBoardGetResponseSchema = z.object({
  type: z.literal("tasks.board.get.response"),
  payload: z.object({
    requestId: z.string(),
    board: TaskBoardSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksBoardSubscribeResponseSchema = z.object({
  type: z.literal("tasks.board.subscribe.response"),
  payload: z.object({
    requestId: z.string(),
    board: TaskBoardSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksBoardUnsubscribeResponseSchema = z.object({
  type: z.literal("tasks.board.unsubscribe.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

export const TasksFolderCreateResponseSchema = z.object({
  type: z.literal("tasks.folder.create.response"),
  payload: z.object({
    requestId: z.string(),
    folder: TaskFolderSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksFolderUpdateResponseSchema = z.object({
  type: z.literal("tasks.folder.update.response"),
  payload: z.object({
    requestId: z.string(),
    folder: TaskFolderSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksFolderDeleteResponseSchema = z.object({
  type: z.literal("tasks.folder.delete.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

export const TasksTaskCreateResponseSchema = z.object({
  type: z.literal("tasks.task.create.response"),
  payload: z.object({
    requestId: z.string(),
    task: KanbanTaskSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksTaskUpdateResponseSchema = z.object({
  type: z.literal("tasks.task.update.response"),
  payload: z.object({
    requestId: z.string(),
    task: KanbanTaskSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksTaskMoveResponseSchema = z.object({
  type: z.literal("tasks.task.move.response"),
  payload: z.object({
    requestId: z.string(),
    board: TaskBoardSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksTaskDeleteResponseSchema = z.object({
  type: z.literal("tasks.task.delete.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

export const TasksTaskEstimateResponseSchema = z.object({
  type: z.literal("tasks.task.estimate.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

export const TasksTaskRunNowResponseSchema = z.object({
  type: z.literal("tasks.task.run_now.response"),
  payload: z.object({
    requestId: z.string(),
    error: z.string().nullable(),
  }),
});

export const TasksTaskApproveResponseSchema = z.object({
  type: z.literal("tasks.task.approve.response"),
  payload: z.object({
    requestId: z.string(),
    task: KanbanTaskSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const TasksConductorEnsureResponseSchema = z.object({
  type: z.literal("tasks.conductor.ensure.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string().nullable(),
    workspaceId: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

// Push event — sent to sessions holding an active board subscription; no .response pair.
export const TasksBoardUpdateMessageSchema = z.object({
  type: z.literal("tasks.board.update"),
  payload: z.object({
    subscriptionId: z.string(),
    projectId: z.string(),
    board: TaskBoardSchema,
  }),
});

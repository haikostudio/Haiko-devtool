import { z } from "zod";
import { AgentAttachmentSchema } from "../attachments.js";
import {
  KanbanTaskSchema,
  TaskBillingSchema,
  TaskBoardSchema,
  TaskColumnSchema,
  TaskFolderSchema,
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
  // Hold the folder's tasks until the user validates each one. Absent = immediate
  // start (the default). Supersedes `autopilot`.
  requireValidation: z.boolean().optional(),
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
  requireValidation: z.boolean().optional(),
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
  attachments: z.array(AgentAttachmentSchema).optional(),
  column: TaskColumnSchema.optional(),
  runConfig: TaskRunConfigSchema.optional(),
  schedulePreference: TaskSchedulePreferenceSchema.optional(),
  // Arm the task's dedicated agent immediately on creation, even in a non-
  // pipeline column like "À faire" (backlog). The inline composer sets this so
  // sending a prompt spawns the analysis/execution agent right away — the card
  // stays in its column but fills in live with the agent's analysis. Omitted =
  // false = a plain draft that only runs once dragged into the pipeline.
  launch: z.boolean().optional(),
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
  // "Retirer du prochain lot" / "Remettre dans le lot" on a card waiting in
  // "À déployer". Additive + optional: old daemons ignore it.
  deployHold: z.boolean().nullable().optional(),
});

export const TasksTaskMoveRequestSchema = z.object({
  type: z.literal("tasks.task.move.request"),
  requestId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  column: TaskColumnSchema,
  index: z.number().int().nonnegative(),
});

// Mark a card as seen (stamps viewedAt once, without reordering it). Dedicated
// RPC — the generic update path bumps updatedAt, which would reshuffle the card.
export const TasksTaskMarkViewedRequestSchema = z.object({
  type: z.literal("tasks.task.mark_viewed.request"),
  requestId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
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

// "Analyser à nouveau": clears a failed analysis so the card is re-analyzed from
// scratch. The only way out of an exhausted analysis — deliberately a user act,
// because three failures in a row usually means something real is broken.
export const TasksTaskRetryAnalysisRequestSchema = z.object({
  type: z.literal("tasks.task.retry_analysis.request"),
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

// "Lancer le contrôle": hand the final check to the task's own agent, in the
// task's own conversation. The agent verifies, fixes what it finds, and
// completes the card itself once everything is green.
export const TasksTaskValidateRequestSchema = z.object({
  type: z.literal("tasks.task.validate.request"),
  requestId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
});

// "Archiver": hide a finished (done/deployed) card from the board. Orthogonal to
// the columns — it stamps `archivedAt` and never moves or publishes the card
// (see docs/task-board-cycle.md). `archived: false` un-archives (clears the
// stamp). Absent `archived` = archive. Additive + optional.
export const TasksTaskArchiveRequestSchema = z.object({
  type: z.literal("tasks.task.archive.request"),
  requestId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  archived: z.boolean().optional(),
});

// "Lancer le déploiement": hand a deploy-then-confirm prompt to a finished card's
// own agent, in the card's own conversation. The agent verifies the work still
// runs, deploys it (dev instance for a project; Paseo publishes itself), then
// moves the card to "deployed" and reports whether a daemon restart is needed.
export const TasksTaskDeployRequestSchema = z.object({
  type: z.literal("tasks.task.deploy.request"),
  requestId: z.string(),
  projectId: z.string(),
  taskId: z.string(),
});

// "Tout déployer": publish EVERY card sitting in the last column ("À déployer")
// whose work is not live yet, in one run, then restart the daemon. The batch is
// what a finished card now waits in — see docs/task-board-cycle.md.
export const TasksBoardDeployAllRequestSchema = z.object({
  type: z.literal("tasks.board.deploy_all.request"),
  requestId: z.string(),
  projectId: z.string(),
});

export const TasksConductorEnsureRequestSchema = z.object({
  type: z.literal("tasks.conductor.ensure.request"),
  requestId: z.string(),
  projectId: z.string(),
  provider: z.string().optional(),
  // "Réinitialiser": archive the project's current conductor and hand back a
  // brand-new one, so the model stops carrying an ever-growing conversation.
  // The archived thread stays readable in the archive; only the ACTIVE context
  // is dropped. Additive + optional — old daemons simply ignore it.
  reset: z.boolean().optional(),
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

export const TasksTaskMarkViewedResponseSchema = z.object({
  type: z.literal("tasks.task.mark_viewed.response"),
  payload: z.object({
    requestId: z.string(),
    // The refreshed board when the stamp actually changed, else null (already
    // seen / task gone) — the subscription push carries the authoritative state.
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

export const TasksTaskRetryAnalysisResponseSchema = z.object({
  type: z.literal("tasks.task.retry_analysis.response"),
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

export const TasksTaskValidateResponseSchema = z.object({
  type: z.literal("tasks.task.validate.response"),
  payload: z.object({
    requestId: z.string(),
    task: KanbanTaskSchema.nullable(),
    // True when the card was already finished, so nothing had to be checked.
    passed: z.boolean(),
    // True when the check prompt was handed to the task's own agent — the
    // verdict then plays out in the conversation, not in this response.
    // Additive + optional: old clients simply ignore it.
    dispatched: z.boolean().optional(),
    error: z.string().nullable(),
  }),
});

export const TasksTaskDeployResponseSchema = z.object({
  type: z.literal("tasks.task.deploy.response"),
  payload: z.object({
    requestId: z.string(),
    task: KanbanTaskSchema.nullable(),
    // True when the deploy prompt was handed to the card's own agent — the
    // outcome then plays out in the conversation, not in this response.
    // Additive + optional: old clients simply ignore it.
    dispatched: z.boolean().optional(),
    // Echoes the card's daemon-restart flag when known at dispatch time (a
    // re-deploy of a card already flagged). The authoritative value lands on the
    // task once the agent finishes. Additive + optional.
    needsDaemonRestart: z.boolean().optional(),
    error: z.string().nullable(),
  }),
});

export const TasksBoardDeployAllResponseSchema = z.object({
  type: z.literal("tasks.board.deploy_all.response"),
  payload: z.object({
    requestId: z.string(),
    // True when the batch publication really started. The run then plays out in
    // the cards' own conversations (and on the board), not in this response.
    started: z.boolean(),
    // The cards this run is taking online. Additive + optional.
    taskIds: z.array(z.string()).optional(),
    error: z.string().nullable(),
  }),
});

export const TasksTaskArchiveResponseSchema = z.object({
  type: z.literal("tasks.task.archive.response"),
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

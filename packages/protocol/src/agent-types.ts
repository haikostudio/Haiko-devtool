import type { AgentAttachment } from "./messages.js";

export type AgentProvider = string;

export interface AgentMetadata {
  [key: string]: unknown;
}

export type AgentProviderNotice =
  | { type: "info"; message: string }
  | { type: "warning"; message: string }
  | { type: "error"; message: string };

/**
 * Stdio-based MCP server (spawns a subprocess).
 */
export interface McpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * HTTP-based MCP server.
 */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * SSE-based MCP server (Server-Sent Events over HTTP).
 */
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * Canonical MCP server configuration.
 * Discriminated union by `type` field.
 * Each provider normalizes this to their expected format.
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export interface AgentMode {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  colorTier?: string;
}

export type ProviderStatus = "ready" | "loading" | "error" | "unavailable";

export interface AgentModelDefinition {
  provider: AgentProvider;
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
  contextWindowMaxTokens?: number;
  thinkingOptions?: AgentSelectOption[];
  defaultThinkingOptionId?: string;
}

export interface AgentSelectOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
}

export function normalizeAgentModelDefinition(model: AgentModelDefinition): AgentModelDefinition {
  const defaultThinkingOptionId =
    model.defaultThinkingOptionId ?? model.thinkingOptions?.find((option) => option.isDefault)?.id;
  if (!defaultThinkingOptionId || defaultThinkingOptionId === model.defaultThinkingOptionId) {
    return model;
  }
  return { ...model, defaultThinkingOptionId };
}

export interface ProviderSnapshotEntry {
  provider: AgentProvider;
  status: ProviderStatus;
  enabled: boolean;
  error?: string;
  models?: AgentModelDefinition[];
  modes?: AgentMode[];
  fetchedAt?: string;
  label?: string;
  description?: string;
  defaultModeId?: string | null;
}

export interface AgentFeatureToggle {
  type: "toggle";
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  value: boolean;
}

export interface AgentFeatureSelect {
  type: "select";
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  icon?: string;
  value: string | null;
  options: AgentSelectOption[];
}

export type AgentFeature = AgentFeatureToggle | AgentFeatureSelect;

export interface AgentCapabilityFlags {
  [capability: string]: boolean | undefined;
  supportsStreaming: boolean;
  supportsSessionPersistence: boolean;
  supportsSessionListing?: boolean;
  supportsDynamicModes: boolean;
  supportsMcpServers: boolean;
  supportsReasoningStream: boolean;
  supportsToolInvocations: boolean;
  supportsRewindConversation?: boolean;
  supportsRewindFiles?: boolean;
  supportsRewindBoth?: boolean;
}

export interface AgentPersistenceHandle {
  provider: AgentProvider;
  sessionId: string;
  /** Provider specific handle (Codex thread id, Claude resume token, etc). */
  nativeHandle?: string;
  metadata?: AgentMetadata;
}

export type AgentPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | AgentAttachment;

export type AgentPromptInput = string | AgentPromptContentBlock[];

export interface AgentRunOptions {
  outputSchema?: unknown;
  resumeFrom?: AgentPersistenceHandle;
  maxThinkingTokens?: number;
}

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export const TOOL_CALL_ICON_NAMES = [
  "wrench",
  "square_terminal",
  "eye",
  "pencil",
  "search",
  "bot",
  "sparkles",
  "brain",
  "mic_vocal",
] as const;

export type ToolCallIconName = (typeof TOOL_CALL_ICON_NAMES)[number];

export type ToolCallDetail =
  | {
      type: "shell";
      command: string;
      cwd?: string;
      output?: string;
      exitCode?: number | null;
    }
  | {
      type: "read";
      filePath: string;
      content?: string;
      offset?: number;
      limit?: number;
    }
  | {
      type: "edit";
      filePath: string;
      oldString?: string;
      newString?: string;
      unifiedDiff?: string;
    }
  | {
      type: "write";
      filePath: string;
      content?: string;
    }
  | {
      type: "search";
      query: string;
      toolName?: "search" | "grep" | "glob" | "web_search";
      content?: string;
      filePaths?: string[];
      webResults?: Array<{
        title: string;
        url: string;
      }>;
      annotations?: string[];
      numFiles?: number;
      numMatches?: number;
      durationMs?: number;
      durationSeconds?: number;
      truncated?: boolean;
      mode?: "content" | "files_with_matches" | "count";
    }
  | {
      type: "fetch";
      url: string;
      prompt?: string;
      result?: string;
      code?: number;
      codeText?: string;
      bytes?: number;
      durationMs?: number;
    }
  | {
      type: "worktree_setup";
      worktreePath: string;
      branchName: string;
      log: string;
      commands: Array<{
        index: number;
        command: string;
        cwd: string;
        log: string;
        status: "running" | "completed" | "failed";
        exitCode: number | null;
        durationMs?: number;
      }>;
      truncated?: boolean;
    }
  | {
      type: "sub_agent";
      subAgentType?: string;
      description?: string;
      childSessionId?: string;
      log: string;
      actions?: Array<{
        index: number;
        toolName: string;
        summary?: string;
      }>;
    }
  | {
      type: "plain_text";
      label?: string;
      text?: string;
      icon?: ToolCallIconName;
    }
  | {
      type: "plan";
      text: string;
    }
  | {
      type: "unknown";
      input: unknown;
      output: unknown;
    };

interface ToolCallBase {
  [key: string]: unknown;
  type: "tool_call";
  callId: string;
  name: string;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
}

type ToolCallRunningTimelineItem = ToolCallBase & {
  status: "running";
  error: null;
};

type ToolCallCompletedTimelineItem = ToolCallBase & {
  status: "completed";
  error: null;
};

type ToolCallFailedTimelineItem = ToolCallBase & {
  status: "failed";
  error: unknown;
};

type ToolCallCanceledTimelineItem = ToolCallBase & {
  status: "canceled";
  error: null;
};

export type ToolCallTimelineItem =
  | ToolCallRunningTimelineItem
  | ToolCallCompletedTimelineItem
  | ToolCallFailedTimelineItem
  | ToolCallCanceledTimelineItem;

export interface CompactionTimelineItem {
  [key: string]: unknown;
  type: "compaction";
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

/**
 * Recall performed by the daemon against the external "Cerveau" memory service
 * before the prompt is dispatched to the agent. Rendered as a distinct (yellow)
 * pill in the chat so the user sees what was looked up and what came back.
 */
export interface BrainContextMemory {
  texte: string;
  rejete?: boolean;
  motif?: string;
  /** ISO date the memory was last confirmed in the Cerveau (optional). */
  date?: string;
}

export interface BrainContextTimelineItem {
  [key: string]: unknown;
  type: "brain_context";
  query: string;
  portee: "projet" | "global" | "apercu";
  count: number;
  memories: BrainContextMemory[];
  status?: "loading" | "done";
}

/**
 * Result of the daemon's inline task-intent triage: when a user message looks
 * like it wants task(s) created, a lightweight LLM either proposed task(s) (now
 * on the board awaiting approval) or needs clarification. Rendered as a distinct
 * pill in the chat so the user sees what happened without leaving the thread.
 */
export interface TaskTriageTimelineItem {
  [key: string]: unknown;
  type: "task_triage";
  status: "questions" | "proposed";
  questions?: string[];
  proposedCount?: number;
  projectId?: string;
  // Ids + title snapshots of the proposed tasks so clients can render live
  // actionable cards against the board. Absent on pre-carousel items.
  tasks?: Array<{ taskId: string; title: string }>;
}

/**
 * Plain-language recap the daemon appends at the end of a turn that changed
 * files. It lets a non-technical reader see, at a glance, what the agent did
 * and which files moved — each tappable to open its diff. `files` is derived
 * deterministically from the turn's edit/write tool calls (never the model);
 * only `summary`/`highlights` are model-written. Rendered as a distinct block
 * at the end of the turn in the chat thread.
 */
export type TurnRecapFileOperation = "created" | "edited" | "deleted";

export interface TurnRecapFileChange {
  /** Path as reported by the tool call (may be absolute or workspace-relative). */
  path: string;
  operation: TurnRecapFileOperation;
}

export interface TurnRecapTimelineItem {
  [key: string]: unknown;
  type: "turn_recap";
  /** One or two plain sentences: what was accomplished this turn. */
  summary: string;
  /** Optional short bullets naming concrete things done, in plain language. */
  highlights?: string[];
  /** Files touched this turn, deduped, driving the "modifications" list. */
  files: TurnRecapFileChange[];
  /** Absolute workspace root, so the client can open each file's diff. */
  cwd?: string;
}

/**
 * Image bytes attached to a user message, carried inside the timeline so that
 * every client — not just the sender that still holds the local copy — can
 * render it. Base64-encoded, matching the `send_agent_message` wire shape.
 */
export interface TimelineImageAttachment {
  /** Base64-encoded image bytes (no `data:` prefix). */
  data: string;
  /** MIME type, e.g. "image/jpeg", "image/png". */
  mimeType: string;
}

export type AgentTimelineItem =
  | {
      type: "user_message";
      text: string;
      messageId?: string;
      /** Attached images, so other clients render them instead of just the text. */
      images?: TimelineImageAttachment[];
    }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | ToolCallTimelineItem
  | { type: "todo"; items: { text: string; completed: boolean }[] }
  | { type: "error"; message: string }
  | CompactionTimelineItem
  | BrainContextTimelineItem
  | TaskTriageTimelineItem
  | TurnRecapTimelineItem;

export type AgentStreamEvent =
  | { type: "thread_started"; sessionId: string; provider: AgentProvider }
  | { type: "turn_started"; provider: AgentProvider; turnId?: string }
  | { type: "turn_completed"; provider: AgentProvider; usage?: AgentUsage; turnId?: string }
  | { type: "usage_updated"; provider: AgentProvider; usage: AgentUsage; turnId?: string }
  | {
      type: "mode_changed";
      provider: AgentProvider;
      currentModeId: string | null;
      availableModes: AgentMode[];
    }
  | { type: "model_changed"; provider: AgentProvider; runtimeInfo: AgentRuntimeInfo }
  | {
      type: "thinking_option_changed";
      provider: AgentProvider;
      thinkingOptionId: string | null;
    }
  | {
      type: "turn_failed";
      provider: AgentProvider;
      error: string;
      code?: string;
      diagnostic?: string;
      turnId?: string;
    }
  | { type: "turn_canceled"; provider: AgentProvider; reason: string; turnId?: string }
  | {
      type: "timeline";
      item: AgentTimelineItem;
      provider: AgentProvider;
      turnId?: string;
      timestamp?: string;
    }
  | {
      type: "permission_requested";
      provider: AgentProvider;
      request: AgentPermissionRequest;
      turnId?: string;
    }
  | {
      type: "permission_resolved";
      provider: AgentProvider;
      requestId: string;
      resolution: AgentPermissionResponse;
      turnId?: string;
    }
  | {
      type: "attention_required";
      provider: AgentProvider;
      reason: "finished" | "error" | "permission";
      timestamp: string;
    };

export function getAgentStreamEventTurnId(event: AgentStreamEvent): string | undefined {
  return "turnId" in event ? event.turnId : undefined;
}

export type AgentPermissionRequestKind = "tool" | "plan" | "question" | "mode" | "other";

export type AgentPermissionUpdate = AgentMetadata;

export interface AgentPermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: "primary" | "secondary" | "danger";
  intent?: "implement" | "implement_resume" | "dismiss";
}

export interface AgentPermissionRequest {
  id: string;
  provider: AgentProvider;
  name: string;
  kind: AgentPermissionRequestKind;
  title?: string;
  description?: string;
  input?: AgentMetadata;
  detail?: ToolCallDetail;
  suggestions?: AgentPermissionUpdate[];
  actions?: AgentPermissionAction[];
  metadata?: AgentMetadata;
}

export type AgentPermissionResponse =
  | {
      behavior: "allow";
      selectedActionId?: string;
      updatedInput?: AgentMetadata;
      updatedPermissions?: AgentPermissionUpdate[];
    }
  | {
      behavior: "deny";
      selectedActionId?: string;
      message?: string;
      interrupt?: boolean;
    };

export interface AgentRunResult {
  sessionId: string;
  finalText: string;
  usage?: AgentUsage;
  timeline: AgentTimelineItem[];
  canceled?: boolean;
}

export interface AgentSessionConfig {
  provider: AgentProvider;
  cwd: string;
  /**
   * Provider-agnostic system/developer instruction string.
   * Mapped by each provider to its native instruction field.
   */
  systemPrompt?: string;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  title?: string | null;
  approvalPolicy?: string;
  sandboxMode?: string;
  networkAccess?: boolean;
  webSearch?: boolean;
  extra?: {
    codex?: AgentMetadata;
    claude?: AgentMetadata;
  };
  mcpServers?: Record<string, McpServerConfig>;
  /**
   * Internal agents are hidden from listings and don't trigger notifications.
   * They are used for ephemeral system tasks like commit/PR generation.
   */
  internal?: boolean;
}

export interface AgentRuntimeInfo {
  provider: AgentProvider;
  sessionId: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
  modeId?: string | null;
  extra?: AgentMetadata;
}

import type { Agent } from "@/stores/session-store";

export type AgentDirectoryEntry = Pick<
  Agent,
  | "id"
  | "serverId"
  | "title"
  | "status"
  | "lastActivityAt"
  | "lastUserMessageAt"
  | "cwd"
  | "workspaceId"
  | "provider"
  | "requiresAttention"
  | "attentionReason"
  | "attentionTimestamp"
  | "archivedAt"
  | "createdAt"
  | "labels"
  | "projectPlacement"
> & {
  pendingPermissionCount?: number;
  // Flattened from the agent's synthesis: its last message asks the user
  // something (a question or an explicit hand-back). Kept as a flat boolean so
  // list consumers never carry the whole synthesis block around. Absent on old
  // daemons — read it as "no question detected".
  awaitsUser?: boolean;
};

import type { WorkspaceUiState } from "@getpaseo/protocol/messages";
import {
  buildWorkspaceTabPersistenceKey,
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { getFocusedAt } from "@/session-ui-state/focus-intent";

// Resolves the draft-store key for a tab whose composer carries a synced draft.
// Only NEW-agent draft tabs are synced. Active-agent message composers are NOT:
// syncing them dragged the agent chat composer through the tombstone/upload/GC
// pipeline, which stripped pasted images from the draft and deleted their blobs,
// breaking image sending. That composer stays purely local.
function getDraftKeyForTab(
  serverId: string,
  tab: { tabId: string; target: WorkspaceTabTarget },
): string | null {
  if (tab.target.kind === "draft") {
    return buildDraftStoreKey({ serverId, agentId: tab.tabId, draftId: tab.target.draftId });
  }
  return null;
}

/**
 * Reads the local, form-factor-agnostic UI state for one workspace: the flat
 * list of open tabs (across all panes), their order, the focused tab, and the
 * draft records referenced by draft tabs. Split-pane geometry is intentionally
 * NOT captured — it stays device-local so a desktop's splits never distort a
 * phone's single-pane view. Returns null when the workspace key is invalid.
 */
export function buildWorkspaceUiState(input: {
  serverId: string;
  workspaceId: string;
  revision: number;
}): WorkspaceUiState | null {
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  if (!workspaceKey) {
    return null;
  }

  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey] ?? null;
  const tabs = layout ? collectAllTabs(layout.root) : [];
  const focusedPane = layout ? findPaneById(layout.root, layout.focusedPaneId) : null;
  const focusedTabId = focusedPane?.focusedTabId ?? null;
  // Carry WHEN the focus last changed (see focus-intent.ts) so receivers resolve
  // focus last-write-wins by intent time, not by our push revision.
  const focusedAt = focusedTabId ? (getFocusedAt(workspaceKey) ?? undefined) : undefined;

  const draftStore = useDraftStore.getState();
  const drafts: WorkspaceUiState["drafts"] = {};
  for (const tab of tabs) {
    const draftKey = getDraftKeyForTab(input.serverId, tab);
    if (!draftKey) {
      continue;
    }
    const record = draftStore.drafts[draftKey];
    if (!record) {
      continue;
    }
    drafts[draftKey] = {
      input: {
        text: record.input.text,
        attachments: record.input.attachments as unknown as Record<string, unknown>[],
      },
      lifecycle: record.lifecycle,
      updatedAt: record.updatedAt,
      version: record.version,
    };
  }

  return {
    tabs: tabs.map((tab) => ({
      tabId: tab.tabId,
      target: tab.target as unknown as Record<string, unknown>,
      createdAt: tab.createdAt,
    })),
    order: tabs.map((tab) => tab.tabId),
    focusedTabId,
    drafts,
    revision: input.revision,
    ...(focusedAt !== undefined ? { focusedAt } : {}),
  };
}

// Reduces a draft attachment to a device-independent identity. Image attachments
// carry a platform-specific storageType/storageKey (IndexedDB key vs. file path)
// that differs per device once bytes are materialized locally; excluding those
// keeps the canonical stable so re-materialization never triggers a push loop.
function canonicalizeAttachment(raw: Record<string, unknown>): unknown {
  if (raw.kind === "image") {
    const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
    return {
      kind: "image",
      id: metadata.id,
      mimeType: metadata.mimeType,
      fileName: metadata.fileName ?? null,
    };
  }
  return raw;
}

// Stable serialization for echo detection. Excludes `revision` (which changes on
// every push regardless of content) and sorts draft keys so equal content always
// canonicalizes identically.
export function canonicalizeWorkspaceUiState(state: WorkspaceUiState): string {
  const drafts: Record<string, unknown> = {};
  for (const key of Object.keys(state.drafts).sort()) {
    const record = state.drafts[key];
    drafts[key] = {
      input: {
        text: record.input.text,
        attachments: record.input.attachments.map(canonicalizeAttachment),
      },
      lifecycle: record.lifecycle,
    };
  }
  return JSON.stringify({
    tabs: state.tabs.map((tab) => ({ tabId: tab.tabId, target: tab.target })),
    order: state.order,
    focusedTabId: state.focusedTabId,
    drafts,
  });
}

// Lists the workspaceIds that currently have layout state for a given server,
// so the sync loop knows which workspaces to snapshot and push.
export function listWorkspaceIdsForServer(serverId: string): string[] {
  const prefix = `${serverId}:`;
  const layoutByWorkspace = useWorkspaceLayoutStore.getState().layoutByWorkspace;
  const workspaceIds: string[] = [];
  for (const key of Object.keys(layoutByWorkspace)) {
    if (key.startsWith(prefix)) {
      workspaceIds.push(key.slice(prefix.length));
    }
  }
  return workspaceIds;
}

import type { WorkspaceUiState } from "@getpaseo/protocol/messages";
import type { UserComposerAttachment } from "@/attachments/types";
import { useDraftStore } from "@/stores/draft-store";
import type { DraftLifecycleState, DraftRecord } from "@/stores/draft-store/state";
import {
  buildWorkspaceTabPersistenceKey,
  collectAllTabs,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { normalizeWorkspaceTabTarget, workspaceTabTargetsEqual } from "@/workspace-tabs/identity";

function coerceLifecycle(lifecycle: string): DraftLifecycleState {
  return lifecycle === "abandoned" || lifecycle === "sent" ? lifecycle : "active";
}

// Writes the remote draft records into the draft-store under their own keys,
// preserving the remote version/updatedAt so the composer reads the exact synced
// content. Direct setState (not saveDraftInput) so we don't bump the version and
// re-trigger a push.
function hydrateDrafts(state: WorkspaceUiState): void {
  const entries = Object.entries(state.drafts);
  if (entries.length === 0) {
    return;
  }
  useDraftStore.setState((prev) => {
    const drafts = { ...prev.drafts };
    for (const [draftKey, record] of entries) {
      // Only new-agent draft-tab composers are synced (buildDraftStoreKey ->
      // "draft:..."). Never apply an "agent:..." record: active-agent message
      // composers are intentionally local (syncing them broke image sending), and
      // a daemon may still hold stale agent tombstones from before that revert.
      if (!draftKey.startsWith("draft:")) {
        continue;
      }
      const existing = drafts[draftKey];
      // Last-write-wins per draft: keep the newer record so a stale broadcast
      // never clobbers freshly typed local text.
      if (existing && existing.updatedAt >= record.updatedAt) {
        continue;
      }
      const next: DraftRecord = {
        input: {
          text: record.input.text,
          attachments: record.input.attachments as unknown as UserComposerAttachment[],
        },
        lifecycle: coerceLifecycle(record.lifecycle),
        updatedAt: record.updatedAt,
        version: record.version,
      };
      drafts[draftKey] = next;
    }
    return { drafts };
  });
}

/**
 * Applies a remote workspace UI state into the local layout + draft stores,
 * synchronously, so the caller can guard against the resulting store mutations
 * echoing back out as a local push. Opens tabs present remotely but missing
 * locally, closes local tabs absent remotely (full adoption of daemon state),
 * then applies order and focus. Split-pane geometry is left untouched.
 */
export function hydrateWorkspaceUiState(input: {
  serverId: string;
  workspaceId: string;
  state: WorkspaceUiState;
}): void {
  const workspaceKey = buildWorkspaceTabPersistenceKey({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
  });
  if (!workspaceKey) {
    return;
  }

  hydrateDrafts(input.state);

  const layoutStore = useWorkspaceLayoutStore.getState();

  const remoteTargets = new Map<string, WorkspaceTabTarget>();
  for (const tab of input.state.tabs) {
    const normalized = normalizeWorkspaceTabTarget(tab.target as unknown as WorkspaceTabTarget);
    if (normalized) {
      remoteTargets.set(tab.tabId, normalized);
    }
  }

  const localLayout = layoutStore.layoutByWorkspace[workspaceKey] ?? null;
  const localTabs = localLayout ? collectAllTabs(localLayout.root) : [];
  const localTabIds = new Set(localTabs.map((tab) => tab.tabId));

  // Close local tabs the remote no longer has.
  for (const tab of localTabs) {
    if (!remoteTargets.has(tab.tabId)) {
      layoutStore.closeTab(workspaceKey, tab.tabId);
    }
  }

  // Open remote tabs missing locally (in remote order so appends land sensibly).
  for (const tabId of input.state.order) {
    const target = remoteTargets.get(tabId);
    if (target && !localTabIds.has(tabId)) {
      layoutStore.openTabInBackground(workspaceKey, target);
    }
  }

  // Refresh the target of tabs that already exist locally but whose remote
  // target changed — e.g. a draft tab whose agent config (target.setup) was
  // edited on another device. Without this, an already-open tab would keep its
  // stale target and only the tab structure (open/close/order) would sync.
  for (const tab of localTabs) {
    const remoteTarget = remoteTargets.get(tab.tabId);
    if (remoteTarget && !workspaceTabTargetsEqual(tab.target, remoteTarget)) {
      layoutStore.retargetTab(workspaceKey, tab.tabId, remoteTarget);
    }
  }

  const existingOrder = input.state.order.filter((tabId) => remoteTargets.has(tabId));
  if (existingOrder.length > 0) {
    layoutStore.reorderTabs(workspaceKey, existingOrder);
  }

  if (input.state.focusedTabId && remoteTargets.has(input.state.focusedTabId)) {
    layoutStore.focusTab(workspaceKey, input.state.focusedTabId);
  }
}

import type { WorkspaceUiState } from "@getpaseo/protocol/messages";
import type { UserComposerAttachment } from "@/attachments/types";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import type { DraftLifecycleState, DraftRecord } from "@/stores/draft-store/state";
import {
  buildWorkspaceTabPersistenceKey,
  collectAllTabs,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "@/workspace-tabs/identity";

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

// A remote draft tab whose create flow already completed on THIS device
// (lifecycle "sent" with a known agentId) is a stale snapshot of the
// pre-handoff layout: our draft tab has since been converted into the agent
// tab. Resolve it to that agent target so a lagging snapshot can never
// resurrect the draft next to the agent tab. This is the "second tab appears
// right after sending the first prompt" bug: another device auto-opens the
// created agent while still holding the (synced) draft tab and pushes both, or
// the daemon replays a pre-submit snapshot on reconnect. Lifecycle "active" is
// deliberately NOT mapped — the local tab is still a draft mid-create, and
// convertDraftToAgentInLayout already collapses onto an agent tab that arrived
// early.
function resolveDraftHandoffTarget(
  serverId: string,
  target: WorkspaceTabTarget,
): WorkspaceTabTarget {
  if (target.kind !== "draft") {
    return target;
  }
  const pending = useCreateFlowStore.getState().pendingByDraftId[target.draftId];
  if (pending?.serverId === serverId && pending.lifecycle === "sent" && pending.agentId) {
    return { kind: "agent", agentId: pending.agentId };
  }
  return target;
}

// Resolves the remote snapshot's tabs into their effective local form: targets
// normalized, handoff-superseded drafts mapped onto their agent tabs (with
// order/focus references following the alias), and duplicates collapsed.
function resolveRemoteTabs(
  serverId: string,
  state: WorkspaceUiState,
): {
  remoteTargets: Map<string, WorkspaceTabTarget>;
  remoteOrder: string[];
  remoteFocusedTabId: string | null;
} {
  const remoteTargets = new Map<string, WorkspaceTabTarget>();
  // Original remote tabId -> effective local tabId, so order/focus references to
  // a handoff-superseded draft tab follow it onto the agent tab it became.
  const remoteTabIdAliases = new Map<string, string>();
  for (const tab of state.tabs) {
    const normalized = normalizeWorkspaceTabTarget(tab.target as unknown as WorkspaceTabTarget);
    if (!normalized) {
      continue;
    }
    const resolved = resolveDraftHandoffTarget(serverId, normalized);
    const tabId = resolved === normalized ? tab.tabId : buildDeterministicWorkspaceTabId(resolved);
    remoteTabIdAliases.set(tab.tabId, tabId);
    // A superseded draft and the agent tab it became can both be present in the
    // snapshot; the Map keyed by effective tabId collapses them into one.
    if (!remoteTargets.has(tabId)) {
      remoteTargets.set(tabId, resolved);
    }
  }
  const remoteOrder: string[] = [];
  for (const tabId of state.order) {
    const effectiveTabId = remoteTabIdAliases.get(tabId) ?? tabId;
    if (remoteTargets.has(effectiveTabId) && !remoteOrder.includes(effectiveTabId)) {
      remoteOrder.push(effectiveTabId);
    }
  }
  const remoteFocusedTabId = state.focusedTabId
    ? (remoteTabIdAliases.get(state.focusedTabId) ?? state.focusedTabId)
    : null;
  return { remoteTargets, remoteOrder, remoteFocusedTabId };
}

// A local new-agent DRAFT tab that still holds unsent work: typed text, attached
// files, or an in-flight create. Host-state adoption must never close such a tab
// just because a stale host snapshot predates it. On reload the local layout and
// draft stores rehydrate from disk before the debounced push (see
// useSessionUiStateSync) has necessarily reached the host, so a snapshot captured
// before the draft existed lacks it — and closing the tab would wipe the whole
// draft at once (text + attachments + model setup are all anchored to it). This
// is exactly the "typed a new agent, reloaded, everything gone" report. An empty
// draft (no content, no pending create) stays closeable, so genuine cross-device
// tab closes still propagate.
function hasUnsentDraftWork(input: {
  serverId: string;
  tab: { tabId: string; target: WorkspaceTabTarget };
}): boolean {
  const { target } = input.tab;
  if (target.kind !== "draft") {
    return false;
  }
  const pending = useCreateFlowStore.getState().pendingByDraftId[target.draftId];
  if (pending?.serverId === input.serverId && pending.lifecycle === "active") {
    return true;
  }
  const draftKey = buildDraftStoreKey({
    serverId: input.serverId,
    agentId: input.tab.tabId,
    draftId: target.draftId,
  });
  const record = useDraftStore.getState().drafts[draftKey];
  if (!record || record.lifecycle !== "active") {
    return false;
  }
  return record.input.text.trim().length > 0 || record.input.attachments.length > 0;
}

/**
 * Applies a remote workspace UI state into the local layout + draft stores,
 * synchronously, so the caller can guard against the resulting store mutations
 * echoing back out as a local push. Opens tabs present remotely but missing
 * locally, closes local tabs absent remotely (full adoption of daemon state,
 * except a local draft still holding unsent work), then applies order and focus.
 * Split-pane geometry is left untouched.
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

  const { remoteTargets, remoteOrder, remoteFocusedTabId } = resolveRemoteTabs(
    input.serverId,
    input.state,
  );

  const localLayout = layoutStore.layoutByWorkspace[workspaceKey] ?? null;
  const localTabs = localLayout ? collectAllTabs(localLayout.root) : [];
  const localTabIds = new Set(localTabs.map((tab) => tab.tabId));

  // Close local tabs the remote no longer has — but keep a local draft that
  // still holds unsent work (see hasUnsentDraftWork). Preserved drafts are
  // re-advertised by the corrective push in useSessionUiStateSync, so the host
  // converges to include them instead of the device losing the user's input.
  for (const tab of localTabs) {
    if (remoteTargets.has(tab.tabId)) {
      continue;
    }
    if (hasUnsentDraftWork({ serverId: input.serverId, tab })) {
      continue;
    }
    layoutStore.closeTab(workspaceKey, tab.tabId);
  }

  // Open remote tabs missing locally (in remote order so appends land sensibly).
  for (const tabId of remoteOrder) {
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

  if (remoteOrder.length > 0) {
    layoutStore.reorderTabs(workspaceKey, remoteOrder);
  }

  if (remoteFocusedTabId && remoteTargets.has(remoteFocusedTabId)) {
    layoutStore.focusTab(workspaceKey, remoteFocusedTabId);
  }
}

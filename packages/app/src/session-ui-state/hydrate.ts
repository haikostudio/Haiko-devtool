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
import { getTabCloseTombstone } from "./close-tombstones";
import { clearTabOpenMarker, hasTabOpenMarker } from "./open-markers";
import { adoptRemoteFocusedAt, getFocusedAt, suppressLocalFocusIntent } from "./focus-intent";
import { logTabSync } from "./sync-log";

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
      const remoteLifecycle = coerceLifecycle(record.lifecycle);
      // A terminal lifecycle ("sent"/"abandoned") is one-way: the composer that
      // draftId represented no longer exists anywhere, so it wins even over a
      // NEWER local "active" record. Without this, a device whose local record
      // stayed active (e.g. its composer kept bumping updatedAt) re-advertises
      // the zombie tab while the other device keeps scrubbing it — the two
      // corrective pushes duel forever (observed live: 9 uiState sets in 27ms,
      // ending in React #185 on the phone).
      const remoteIsTerminal = remoteLifecycle !== "active";
      const localIsTerminal = existing != null && existing.lifecycle !== "active";
      // Last-write-wins per draft otherwise: keep the newer record so a stale
      // broadcast never clobbers freshly typed local text.
      if (
        existing &&
        existing.updatedAt >= record.updatedAt &&
        !(remoteIsTerminal && !localIsTerminal)
      ) {
        continue;
      }
      // Never resurrect a locally-terminal draft from a stale active record.
      if (localIsTerminal && !remoteIsTerminal) {
        continue;
      }
      const next: DraftRecord = {
        input: {
          text: record.input.text,
          attachments: record.input.attachments as unknown as UserComposerAttachment[],
        },
        lifecycle: remoteLifecycle,
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

// A remote draft tab whose draft record reached a terminal lifecycle ("sent" or
// "abandoned") is a zombie: the composer it represented no longer exists. The
// create-flow mapping (resolveDraftHandoffTarget) can only translate such a tab
// into its agent tab on the device that submitted it, and only until reload —
// the pending map is in-memory. Any other device (or the same one after a
// reload) would faithfully re-open it as an empty composer, forever, because
// the daemon keeps re-advertising it as authoritative state. Observed live in a
// daemon ui-state snapshot: a draft tab still listed (and focused) while its
// own synced record said lifecycle "sent". hydrateDrafts has already merged the
// remote records last-write-wins, so the local store is the authority here.
function getTerminalDraftLifecycle(input: {
  serverId: string;
  tabId: string;
  target: WorkspaceTabTarget;
}): "sent" | "abandoned" | null {
  if (input.target.kind !== "draft") {
    return null;
  }
  const draftKey = buildDraftStoreKey({
    serverId: input.serverId,
    agentId: input.tabId,
    draftId: input.target.draftId,
  });
  const lifecycle = useDraftStore.getState().drafts[draftKey]?.lifecycle;
  return lifecycle === "sent" || lifecycle === "abandoned" ? lifecycle : null;
}

// Scrubs the resolved remote view BEFORE adoption. Two classes of tabs are
// removed in place: zombie draft tabs (terminal draft lifecycle, see
// getTerminalDraftLifecycle) and tabs the user closed locally AFTER the
// snapshot was taken (close tombstones — a snapshot whose revision predates
// the close is a stale replay, not a genuine cross-device reopen). The
// corrective push in useSessionUiStateSync then advertises the scrubbed state,
// so the daemon converges on the cleanup instead of re-broadcasting the zombie
// forever.
function scrubRemoteTabs(input: {
  serverId: string;
  workspaceKey: string;
  remoteRevision: number;
  remoteTargets: Map<string, WorkspaceTabTarget>;
  localTabIds: Set<string>;
}): void {
  for (const [tabId, target] of Array.from(input.remoteTargets)) {
    const terminalLifecycle = getTerminalDraftLifecycle({
      serverId: input.serverId,
      tabId,
      target,
    });
    if (terminalLifecycle) {
      input.remoteTargets.delete(tabId);
      logTabSync("dropping zombie draft tab from host snapshot", {
        workspaceKey: input.workspaceKey,
        tabId,
        lifecycle: terminalLifecycle,
        remoteRevision: input.remoteRevision,
      });
      continue;
    }
    if (!input.localTabIds.has(tabId)) {
      const closedAt = getTabCloseTombstone(input.workspaceKey, tabId);
      if (closedAt !== null && input.remoteRevision <= closedAt) {
        input.remoteTargets.delete(tabId);
        logTabSync("suppressing reopen of a tab closed after this snapshot", {
          workspaceKey: input.workspaceKey,
          tabId,
          targetKind: target.kind,
          closedAt,
          remoteRevision: input.remoteRevision,
        });
      }
    }
  }
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

  // Every store mutation below comes FROM the daemon, not the user — bracket the
  // whole pass so it never registers as local focus intent (see focus-intent).
  suppressLocalFocusIntent(() => {
    applyRemoteWorkspaceUiState(workspaceKey, input);
  });
}

function applyRemoteWorkspaceUiState(
  workspaceKey: string,
  input: {
    serverId: string;
    workspaceId: string;
    state: WorkspaceUiState;
  },
): void {
  hydrateDrafts(input.state);

  const layoutStore = useWorkspaceLayoutStore.getState();

  const { remoteTargets, remoteOrder, remoteFocusedTabId } = resolveRemoteTabs(
    input.serverId,
    input.state,
  );

  const localLayout = layoutStore.layoutByWorkspace[workspaceKey] ?? null;
  const localTabs = localLayout ? collectAllTabs(localLayout.root) : [];
  const localTabIds = new Set(localTabs.map((tab) => tab.tabId));

  scrubRemoteTabs({
    serverId: input.serverId,
    workspaceKey,
    remoteRevision: input.state.revision,
    remoteTargets,
    localTabIds,
  });
  const effectiveOrder = remoteOrder.filter((tabId) => remoteTargets.has(tabId));

  // A tab the host now advertises is acknowledged: drop any open marker so a
  // later snapshot that omits it reads as a genuine cross-device close rather
  // than an unacknowledged local open (see open-markers).
  for (const tabId of remoteTargets.keys()) {
    clearTabOpenMarker(workspaceKey, tabId);
  }

  // Close local tabs the remote no longer has — but keep a local draft that
  // still holds unsent work (see hasUnsentDraftWork). Preserved drafts are
  // re-advertised by the corrective push in useSessionUiStateSync, so the host
  // converges to include them instead of the device losing the user's input.
  for (const tab of localTabs) {
    if (remoteTargets.has(tab.tabId)) {
      continue;
    }
    if (hasUnsentDraftWork({ serverId: input.serverId, tab })) {
      logTabSync("preserving local draft with unsent work", {
        workspaceKey,
        tabId: tab.tabId,
        remoteRevision: input.state.revision,
      });
      continue;
    }
    // A brand-new draft tab the user just opened, not yet acknowledged by the
    // host: preserve it so adoption of a snapshot captured before it existed
    // can't make it vanish on its own (see open-markers). Only draft tabs — an
    // agent tab absent from the host was archived elsewhere and should close.
    // A draft whose own record is terminal ("sent"/"abandoned") is a zombie, not
    // a live new tab, so the marker must never rescue it.
    if (
      tab.target.kind === "draft" &&
      hasTabOpenMarker(workspaceKey, tab.tabId) &&
      !getTerminalDraftLifecycle({
        serverId: input.serverId,
        tabId: tab.tabId,
        target: tab.target,
      })
    ) {
      logTabSync("preserving unacknowledged local draft tab", {
        workspaceKey,
        tabId: tab.tabId,
        remoteRevision: input.state.revision,
      });
      continue;
    }
    logTabSync("closing local tab absent from host snapshot", {
      workspaceKey,
      tabId: tab.tabId,
      targetKind: tab.target.kind,
      remoteRevision: input.state.revision,
    });
    layoutStore.closeTab(workspaceKey, tab.tabId);
  }

  // Open remote tabs missing locally (in remote order so appends land sensibly).
  for (const tabId of effectiveOrder) {
    const target = remoteTargets.get(tabId);
    if (target && !localTabIds.has(tabId)) {
      // Logged prominently: a tab reappearing here (rather than via the local
      // empty-workspace seed) means the host snapshot still advertises a tab the
      // user may have just closed on another device / before a reconnect.
      logTabSync("reopening tab from host snapshot", {
        workspaceKey,
        tabId,
        targetKind: target.kind,
        remoteRevision: input.state.revision,
      });
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

  if (effectiveOrder.length > 0) {
    layoutStore.reorderTabs(workspaceKey, effectiveOrder);
  }

  if (remoteFocusedTabId && remoteTargets.has(remoteFocusedTabId)) {
    applyRemoteFocus({
      workspaceKey,
      layoutStore,
      remoteFocusedTabId,
      remoteRevision: input.state.revision,
      remoteFocusedAt: input.state.focusedAt ?? null,
    });
  }
}

// Focus is last-write-wins by focusedAt — the time the focus itself changed, NOT
// the push time (revision). This is what makes focus survive a live cross-device
// push duel: a device re-advertising an unchanged focus carries an OLD focusedAt,
// so it can never yank focus away from the device the user is actually touching.
// See focus-intent.ts.
function applyRemoteFocus(input: {
  workspaceKey: string;
  layoutStore: ReturnType<typeof useWorkspaceLayoutStore.getState>;
  remoteFocusedTabId: string;
  remoteRevision: number;
  remoteFocusedAt: number | null;
}): void {
  const { workspaceKey, layoutStore, remoteFocusedTabId, remoteRevision, remoteFocusedAt } = input;
  const localFocusedAt = getFocusedAt(workspaceKey);

  let adoptRemoteFocus: boolean;
  if (remoteFocusedAt === null) {
    // Pre-0.1.109 peer: no focusedAt on the wire. Fall back to the legacy guard —
    // reject a snapshot whose revision predates our last local focus.
    adoptRemoteFocus = !(localFocusedAt !== null && remoteRevision <= localFocusedAt);
  } else if (localFocusedAt === null) {
    // This device has no focus history yet (e.g. fresh after a reload) — the
    // daemon's focus is authoritative.
    adoptRemoteFocus = true;
  } else {
    // Both sides know when their focus changed: newer wins, ties keep local
    // (stability — the device already showing this focus does not flicker).
    adoptRemoteFocus = remoteFocusedAt > localFocusedAt;
  }

  if (adoptRemoteFocus) {
    layoutStore.focusTab(workspaceKey, remoteFocusedTabId);
    // Remember the focusedAt we adopted so our own next push re-advertises it
    // instead of minting a fresh timestamp that would re-open the duel. The
    // focusTab above is a no-op for local intent (we are under the suppress
    // bracket), so this explicit record is the only thing that updates it.
    adoptRemoteFocusedAt(workspaceKey, remoteFocusedAt ?? remoteRevision);
  } else {
    logTabSync("keeping local focus over stale host snapshot", {
      workspaceKey,
      remoteFocusedTabId,
      remoteRevision,
      remoteFocusedAt,
      localFocusedAt,
    });
  }
}

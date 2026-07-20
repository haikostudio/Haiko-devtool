import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import type { WorkspaceUiState } from "@getpaseo/protocol/messages";
import { resetTabCloseTombstonesForTest } from "@/session-ui-state/close-tombstones";
import { resetLocalFocusIntentForTest } from "@/session-ui-state/focus-intent";
import { hydrateWorkspaceUiState } from "@/session-ui-state/hydrate";
import { buildWorkspaceUiState } from "@/session-ui-state/snapshot";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import {
  buildWorkspaceTabPersistenceKey,
  collectAllTabs,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { WorkspaceDraftTabSetup } from "@/stores/workspace-tabs-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "ws-main";
const WORKSPACE_KEY = buildWorkspaceTabPersistenceKey({
  serverId: SERVER_ID,
  workspaceId: WORKSPACE_ID,
});

if (!WORKSPACE_KEY) {
  throw new Error("workspace key is required for the test setup");
}

const BASE_SETUP: WorkspaceDraftTabSetup = {
  provider: "claude",
  cwd: "/repo",
  modeId: "default",
  model: "opus",
  thinkingOptionId: null,
  featureValues: {},
};

function draftSetup(target: unknown): WorkspaceDraftTabSetup {
  return (target as { setup: WorkspaceDraftTabSetup }).setup;
}

describe("session ui state draft config sync", () => {
  beforeEach(() => {
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
    useDraftStore.setState({ drafts: {}, createModalDraft: null });
    useCreateFlowStore.getState().clearAll();
    resetTabCloseTombstonesForTest();
    resetLocalFocusIntentForTest();
  });

  it("does NOT capture the composer draft of an already-active agent tab", () => {
    useWorkspaceLayoutStore
      .getState()
      .openTabInBackground(WORKSPACE_KEY, { kind: "agent", agentId: "agent-1" });
    const agentDraftKey = buildDraftStoreKey({ serverId: SERVER_ID, agentId: "agent-1" });
    useDraftStore.setState((previous) => ({
      drafts: {
        ...previous.drafts,
        [agentDraftKey]: {
          input: { text: "message in progress", attachments: [] },
          lifecycle: "active",
          updatedAt: 10,
          version: 1,
        } as unknown as (typeof previous.drafts)[string],
      },
    }));

    const built = buildWorkspaceUiState({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      revision: 1,
    });
    // Active-agent composers are intentionally NOT synced (it broke image send).
    expect(built?.drafts[agentDraftKey]).toBeUndefined();
  });

  it("captures the draft agent config in the snapshot target.setup", () => {
    useWorkspaceLayoutStore
      .getState()
      .openTabInBackground(WORKSPACE_KEY, { kind: "draft", draftId: "d1", setup: BASE_SETUP });

    const built = buildWorkspaceUiState({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      revision: 1,
    });
    expect(built).not.toBeNull();
    const tab = built?.tabs.find((entry) => entry.tabId === "d1");
    expect(tab).toBeDefined();
    expect(draftSetup(tab?.target).model).toBe("opus");
    expect(draftSetup(tab?.target).modeId).toBe("default");
  });

  it("does not resurrect a draft tab this device already converted into its agent", () => {
    // Local state: the draft d1 was submitted and converted into agent tab
    // agent_a1 (the create flow recorded the handoff as "sent").
    useWorkspaceLayoutStore
      .getState()
      .openTabInBackground(WORKSPACE_KEY, { kind: "agent", agentId: "a1" });
    useCreateFlowStore.getState().setPending({
      draftId: "d1",
      serverId: SERVER_ID,
      agentId: null,
      clientMessageId: "m1",
      text: "hello",
      timestamp: 1,
    });
    useCreateFlowStore.getState().updateAgentId({ draftId: "d1", agentId: "a1" });
    useCreateFlowStore.getState().markLifecycle({ draftId: "d1", lifecycle: "sent" });

    // Stale remote snapshot from before the submit: still holds the draft.
    const remote: WorkspaceUiState = {
      tabs: [
        { tabId: "d1", target: { kind: "draft", draftId: "d1", setup: BASE_SETUP }, createdAt: 1 },
      ],
      order: ["d1"],
      focusedTabId: "d1",
      drafts: {},
      revision: 2,
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: remote });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const tabs = collectAllTabs(layout.root);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.target).toEqual({ kind: "agent", agentId: "a1" });
    // Focus on the stale draft follows the handoff onto the agent tab.
    const applied = buildWorkspaceUiState({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      revision: 0,
    });
    expect(applied?.focusedTabId).toBe("agent_a1");
  });

  it("collapses a stale draft and the agent tab it became into one tab", () => {
    // Another device auto-opened the created agent while still holding the
    // synced draft tab, then pushed both.
    useWorkspaceLayoutStore
      .getState()
      .openTabInBackground(WORKSPACE_KEY, { kind: "agent", agentId: "a1" });
    useCreateFlowStore.getState().setPending({
      draftId: "d1",
      serverId: SERVER_ID,
      agentId: null,
      clientMessageId: "m1",
      text: "hello",
      timestamp: 1,
    });
    useCreateFlowStore.getState().updateAgentId({ draftId: "d1", agentId: "a1" });
    useCreateFlowStore.getState().markLifecycle({ draftId: "d1", lifecycle: "sent" });

    const remote: WorkspaceUiState = {
      tabs: [
        { tabId: "d1", target: { kind: "draft", draftId: "d1", setup: BASE_SETUP }, createdAt: 1 },
        { tabId: "agent_a1", target: { kind: "agent", agentId: "a1" }, createdAt: 2 },
      ],
      order: ["d1", "agent_a1"],
      focusedTabId: "d1",
      drafts: {},
      revision: 2,
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: remote });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const tabs = collectAllTabs(layout.root);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.target).toEqual({ kind: "agent", agentId: "a1" });
  });

  it("keeps a remote draft tab while its create flow is still in flight", () => {
    useWorkspaceLayoutStore
      .getState()
      .openTabInBackground(WORKSPACE_KEY, { kind: "draft", draftId: "d1", setup: BASE_SETUP });
    // Pending create is still "active" (no agent yet): the draft must survive.
    useCreateFlowStore.getState().setPending({
      draftId: "d1",
      serverId: SERVER_ID,
      agentId: null,
      clientMessageId: "m1",
      text: "hello",
      timestamp: 1,
    });

    const remote: WorkspaceUiState = {
      tabs: [
        { tabId: "d1", target: { kind: "draft", draftId: "d1", setup: BASE_SETUP }, createdAt: 1 },
      ],
      order: ["d1"],
      focusedTabId: "d1",
      drafts: {},
      revision: 2,
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: remote });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const tabs = collectAllTabs(layout.root);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.target.kind).toBe("draft");
  });

  it("preserves a local draft with unsent typed text when the host snapshot predates it", () => {
    // The user typed into a brand-new draft and reloaded before the debounced
    // push reached the host. Local state rehydrates from disk; the host snapshot
    // does not know the draft yet. Adoption must NOT close it.
    useWorkspaceLayoutStore
      .getState()
      .openTabInBackground(WORKSPACE_KEY, { kind: "draft", draftId: "d1", setup: BASE_SETUP });
    const draftKey = buildDraftStoreKey({ serverId: SERVER_ID, agentId: "d1", draftId: "d1" });
    useDraftStore.setState((previous) => ({
      drafts: {
        ...previous.drafts,
        [draftKey]: {
          input: { text: "half-written prompt", attachments: [] },
          lifecycle: "active",
          updatedAt: 5,
          version: 1,
        } as unknown as (typeof previous.drafts)[string],
      },
    }));

    const remote: WorkspaceUiState = {
      tabs: [],
      order: [],
      focusedTabId: null,
      drafts: {},
      revision: 2,
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: remote });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const tabs = collectAllTabs(layout.root);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.target).toMatchObject({ kind: "draft", draftId: "d1" });
    // The model setup rides along on the preserved tab.
    expect(draftSetup(tabs[0]?.target).model).toBe("opus");
  });

  it("still closes an empty local draft the host dropped", () => {
    // An empty draft carries no unsent work, so a genuine cross-device close
    // must still propagate — we do not leak stale empty drafts.
    useWorkspaceLayoutStore
      .getState()
      .openTabInBackground(WORKSPACE_KEY, { kind: "draft", draftId: "d1", setup: BASE_SETUP });

    const remote: WorkspaceUiState = {
      tabs: [],
      order: [],
      focusedTabId: null,
      drafts: {},
      revision: 2,
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: remote });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const tabs = collectAllTabs(layout.root);
    expect(tabs).toHaveLength(0);
  });

  it("drops a zombie draft tab whose synced record says the draft was already sent", () => {
    // The daemon still advertises a draft tab (even focused), but the draft's
    // own synced record is lifecycle "sent": the prompt became an agent long
    // ago. No create-flow pending exists (the device reloaded since), so the
    // handoff mapping cannot translate it. The zombie must not open — and if it
    // is already open locally, it must close.
    useWorkspaceLayoutStore
      .getState()
      .openTabInBackground(WORKSPACE_KEY, { kind: "draft", draftId: "d1", setup: BASE_SETUP });
    const draftKey = buildDraftStoreKey({ serverId: SERVER_ID, agentId: "d1", draftId: "d1" });

    const remote: WorkspaceUiState = {
      tabs: [
        { tabId: "d1", target: { kind: "draft", draftId: "d1", setup: BASE_SETUP }, createdAt: 1 },
      ],
      order: ["d1"],
      focusedTabId: "d1",
      drafts: {
        [draftKey]: {
          input: { text: "", attachments: [] },
          lifecycle: "sent",
          updatedAt: 5,
          version: 7,
        },
      },
      revision: 2,
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: remote });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(collectAllTabs(layout.root)).toHaveLength(0);
  });

  it("adopts a terminal draft lifecycle even when the local active record is newer", () => {
    // The corrective-push duel: this device's record is still "active" (and
    // NEWER — its composer kept bumping updatedAt), so plain last-write-wins
    // would keep re-advertising the tab while the abandoning device keeps
    // scrubbing it — the two devices answer each other's broadcasts forever
    // (observed live as 9 uiState sets in 27ms and a React #185 phone crash).
    // Terminal lifecycles are one-way: the abandon must win regardless of age.
    useWorkspaceLayoutStore
      .getState()
      .openTabInBackground(WORKSPACE_KEY, { kind: "draft", draftId: "d1", setup: BASE_SETUP });
    const draftKey = buildDraftStoreKey({ serverId: SERVER_ID, agentId: "d1", draftId: "d1" });
    useDraftStore.setState((previous) => ({
      drafts: {
        ...previous.drafts,
        [draftKey]: {
          input: { text: "typed text still here", attachments: [] },
          lifecycle: "active",
          updatedAt: 100,
          version: 3,
        } as unknown as (typeof previous.drafts)[string],
      },
    }));

    const remote: WorkspaceUiState = {
      tabs: [
        { tabId: "d1", target: { kind: "draft", draftId: "d1", setup: BASE_SETUP }, createdAt: 1 },
      ],
      order: ["d1"],
      focusedTabId: "d1",
      drafts: {
        [draftKey]: {
          input: { text: "", attachments: [] },
          lifecycle: "abandoned",
          updatedAt: 50,
          version: 7,
        },
      },
      revision: 2,
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: remote });

    // The record turned terminal and the zombie tab closed — the snapshot this
    // device now advertises no longer contains the tab, so the duel converges.
    expect(useDraftStore.getState().drafts[draftKey]?.lifecycle).toBe("abandoned");
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(collectAllTabs(layout.root)).toHaveLength(0);
    const built = buildWorkspaceUiState({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      revision: 3,
    });
    expect(built?.tabs).toHaveLength(0);
  });

  it("keeps a locally-terminal draft dead when a stale active record arrives", () => {
    // Mirror rule: once THIS device knows the draft is sent/abandoned, an old
    // "active" record replayed by the daemon must not resurrect the composer.
    const draftKey = buildDraftStoreKey({ serverId: SERVER_ID, agentId: "d1", draftId: "d1" });
    useDraftStore.setState((previous) => ({
      drafts: {
        ...previous.drafts,
        [draftKey]: {
          input: { text: "", attachments: [] },
          lifecycle: "abandoned",
          updatedAt: 10,
          version: 2,
        } as unknown as (typeof previous.drafts)[string],
      },
    }));

    const remote: WorkspaceUiState = {
      tabs: [
        { tabId: "d1", target: { kind: "draft", draftId: "d1", setup: BASE_SETUP }, createdAt: 1 },
      ],
      order: ["d1"],
      focusedTabId: "d1",
      drafts: {
        [draftKey]: {
          input: { text: "old text", attachments: [] },
          lifecycle: "active",
          updatedAt: 999,
          version: 1,
        },
      },
      revision: 2,
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: remote });

    expect(useDraftStore.getState().drafts[draftKey]?.lifecycle).toBe("abandoned");
    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const tabs = layout ? collectAllTabs(layout.root) : [];
    expect(tabs).toHaveLength(0);
  });

  it("does not open a zombie draft tab on a device that never had it", () => {
    const draftKey = buildDraftStoreKey({ serverId: SERVER_ID, agentId: "d1", draftId: "d1" });
    const remote: WorkspaceUiState = {
      tabs: [
        { tabId: "d1", target: { kind: "draft", draftId: "d1", setup: BASE_SETUP }, createdAt: 1 },
      ],
      order: ["d1"],
      focusedTabId: "d1",
      drafts: {
        [draftKey]: {
          input: { text: "", attachments: [] },
          lifecycle: "sent",
          updatedAt: 5,
          version: 7,
        },
      },
      revision: 2,
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: remote });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const tabs = layout ? collectAllTabs(layout.root) : [];
    expect(tabs).toHaveLength(0);
  });

  it("does not reopen a tab the user closed after the snapshot was taken", () => {
    // The user closes a tab; a snapshot captured BEFORE the close (stale
    // broadcast, or the adopt-on-connect fetch racing the close) still lists
    // it. Adoption must not resurrect it — the close wins.
    const store = useWorkspaceLayoutStore.getState();
    store.openTabInBackground(WORKSPACE_KEY, { kind: "agent", agentId: "a1" });
    store.closeTab(WORKSPACE_KEY, "agent_a1");

    const remote: WorkspaceUiState = {
      tabs: [{ tabId: "agent_a1", target: { kind: "agent", agentId: "a1" }, createdAt: 1 }],
      order: ["agent_a1"],
      focusedTabId: "agent_a1",
      drafts: {},
      revision: 2, // predates the close
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: remote });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(collectAllTabs(layout.root)).toHaveLength(0);
  });

  it("still adopts a genuine cross-device reopen newer than the local close", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.openTabInBackground(WORKSPACE_KEY, { kind: "agent", agentId: "a1" });
    store.closeTab(WORKSPACE_KEY, "agent_a1");

    const remote: WorkspaceUiState = {
      tabs: [{ tabId: "agent_a1", target: { kind: "agent", agentId: "a1" }, createdAt: 1 }],
      order: ["agent_a1"],
      focusedTabId: "agent_a1",
      drafts: {},
      revision: Date.now() + 60_000, // pushed after the close: a real reopen
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: remote });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const tabs = collectAllTabs(layout.root);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.target).toEqual({ kind: "agent", agentId: "a1" });
  });

  it("applies a changed remote setup to an already-open draft tab", () => {
    useWorkspaceLayoutStore
      .getState()
      .openTabInBackground(WORKSPACE_KEY, { kind: "draft", draftId: "d1", setup: BASE_SETUP });

    const remote: WorkspaceUiState = {
      tabs: [
        {
          tabId: "d1",
          target: {
            kind: "draft",
            draftId: "d1",
            setup: { ...BASE_SETUP, model: "sonnet", modeId: "plan" },
          },
          createdAt: 1,
        },
      ],
      order: ["d1"],
      focusedTabId: "d1",
      drafts: {},
      revision: 2,
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: remote });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const tab = collectAllTabs(layout.root).find((entry) => entry.tabId === "d1");
    expect(tab).toBeDefined();
    expect(draftSetup(tab?.target).model).toBe("sonnet");
    expect(draftSetup(tab?.target).modeId).toBe("plan");
  });

  it("keeps a tab the user just focused when a stale broadcast points at the previous one", () => {
    // The user has two agent tabs and clicks into agent_a2. Before the debounced
    // local push reaches the daemon, a stale broadcast arrives still focusing the
    // previous tab (agent_a1). Adoption must not steal focus back — the classic
    // "click a tab, focus jumps to the previous one" race.
    const store = useWorkspaceLayoutStore.getState();
    store.openTabInBackground(WORKSPACE_KEY, { kind: "agent", agentId: "a1" });
    store.openTabInBackground(WORKSPACE_KEY, { kind: "agent", agentId: "a2" });
    store.focusTab(WORKSPACE_KEY, "agent_a2"); // records local focus intent (now)

    const stale: WorkspaceUiState = {
      tabs: [
        { tabId: "agent_a1", target: { kind: "agent", agentId: "a1" }, createdAt: 1 },
        { tabId: "agent_a2", target: { kind: "agent", agentId: "a2" }, createdAt: 2 },
      ],
      order: ["agent_a1", "agent_a2"],
      focusedTabId: "agent_a1",
      drafts: {},
      revision: 1, // predates the local click
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: stale });

    const applied = buildWorkspaceUiState({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      revision: 0,
    });
    expect(applied?.focusedTabId).toBe("agent_a2");
  });

  it("keeps focus on the tab whose first prompt was just sent (draft -> agent retarget)", () => {
    // The first-prompt handoff converts the focused draft tab into its agent tab
    // in place via retargetTab (not focusTab / convertDraftToAgent). While the
    // daemon runs its brain recall, a stale broadcast arrives still focusing the
    // PREVIOUS tab. retargetTab must record local focus intent so adoption does
    // not yank focus back mid-request — the reported "send first prompt, focus
    // jumps to the previous agent" race.
    const store = useWorkspaceLayoutStore.getState();
    store.openTabInBackground(WORKSPACE_KEY, { kind: "agent", agentId: "a1" });
    store.openTabInBackground(WORKSPACE_KEY, { kind: "draft", draftId: "d1", setup: BASE_SETUP });
    store.focusTab(WORKSPACE_KEY, "d1");
    // Drafts are opened via retargetTab, which historically recorded no intent —
    // clear it so the only thing that can defend focus is the retarget below.
    resetLocalFocusIntentForTest();

    store.retargetTab(WORKSPACE_KEY, "d1", { kind: "agent", agentId: "a2" });

    const stale: WorkspaceUiState = {
      tabs: [
        { tabId: "agent_a1", target: { kind: "agent", agentId: "a1" }, createdAt: 1 },
        { tabId: "d1", target: { kind: "agent", agentId: "a2" }, createdAt: 2 },
      ],
      order: ["agent_a1", "d1"],
      focusedTabId: "agent_a1",
      drafts: {},
      revision: 1, // predates the local send
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: stale });

    const applied = buildWorkspaceUiState({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      revision: 0,
    });
    expect(applied?.focusedTabId).toBe("d1");
  });

  it("still adopts a genuine cross-device focus change newer than the local click", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.openTabInBackground(WORKSPACE_KEY, { kind: "agent", agentId: "a1" });
    store.openTabInBackground(WORKSPACE_KEY, { kind: "agent", agentId: "a2" });
    store.focusTab(WORKSPACE_KEY, "agent_a2"); // records local focus intent (now)

    const remote: WorkspaceUiState = {
      tabs: [
        { tabId: "agent_a1", target: { kind: "agent", agentId: "a1" }, createdAt: 1 },
        { tabId: "agent_a2", target: { kind: "agent", agentId: "a2" }, createdAt: 2 },
      ],
      order: ["agent_a1", "agent_a2"],
      focusedTabId: "agent_a1",
      drafts: {},
      revision: Date.now() + 60_000, // another device focused a1 after our click
    };

    hydrateWorkspaceUiState({ serverId: SERVER_ID, workspaceId: WORKSPACE_ID, state: remote });

    const applied = buildWorkspaceUiState({
      serverId: SERVER_ID,
      workspaceId: WORKSPACE_ID,
      revision: 0,
    });
    expect(applied?.focusedTabId).toBe("agent_a1");
  });
});

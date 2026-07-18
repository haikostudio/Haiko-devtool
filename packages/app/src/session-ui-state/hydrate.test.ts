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
});

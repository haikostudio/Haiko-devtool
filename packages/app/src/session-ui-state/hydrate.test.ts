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

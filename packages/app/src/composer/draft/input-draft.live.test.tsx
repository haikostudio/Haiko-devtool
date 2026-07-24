import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useDraftStore } from "@/stores/draft-store";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";

const { asyncStorage } = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
}));

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      asyncStorage.set(key, value);
    },
    removeItem: async (key: string) => {
      asyncStorage.delete(key);
    },
  },
}));

vi.mock("@/attachments/service", () => ({
  garbageCollectAttachments: async () => undefined,
}));

vi.mock("@/hooks/use-agent-form-state", () => ({
  useAgentFormState: () => ({
    selectedServerId: "host-1",
    setSelectedServerId: () => undefined,
    setSelectedServerIdFromUser: () => undefined,
    selectedProvider: "codex",
    setProviderFromUser: () => undefined,
    selectedMode: "auto",
    setModeFromUser: () => undefined,
    selectedModel: "",
    setModelFromUser: () => undefined,
    selectedThinkingOptionId: "",
    setThinkingOptionFromUser: () => undefined,
    workingDir: "/repo",
    setWorkingDir: () => undefined,
    setWorkingDirFromUser: () => undefined,
    providerDefinitions: [{ id: "codex", label: "Codex", modes: [{ id: "auto", label: "Auto" }] }],
    providerDefinitionMap: new Map(),
    agentDefinition: undefined,
    modeOptions: [{ id: "auto", label: "Auto" }],
    availableModels: [
      {
        provider: "codex",
        id: "gpt-5.4",
        label: "gpt-5.4",
        isDefault: true,
        defaultThinkingOptionId: "high",
        thinkingOptions: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ],
    allProviderModels: new Map([
      [
        "codex",
        [
          {
            provider: "codex",
            id: "gpt-5.4",
            label: "gpt-5.4",
            isDefault: true,
            defaultThinkingOptionId: "high",
            thinkingOptions: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
            ],
          },
        ],
      ],
    ]),
    modelSelectorProviders: [
      {
        id: "codex",
        label: "Codex",
        modelSelection: {
          kind: "models",
          rows: [
            {
              favoriteKey: "codex:gpt-5.4",
              provider: "codex",
              providerLabel: "Codex",
              modelId: "gpt-5.4",
              modelLabel: "gpt-5.4",
              isDefault: true,
            },
          ],
        },
      },
    ],
    isAllModelsLoading: false,
    isProviderModelsRefreshing: false,
    availableThinkingOptions: [
      { id: "medium", label: "Medium" },
      { id: "high", label: "High", isDefault: true },
    ],
    isModelLoading: false,
    modelError: null,
    refreshProviderModels: () => undefined,
    setProviderAndModelFromUser: () => undefined,
    workingDirIsEmpty: false,
    persistFormPreferences: async () => undefined,
  }),
}));

let useAgentInputDraft: typeof import("./input-draft").useAgentInputDraft;
type DraftRecordForTest = ReturnType<typeof useDraftStore.getState>["drafts"][string];

// Writes a draft into the store as if a remote cross-device update landed
// (hydrateWorkspaceUiState does this on a broadcast). Kept at module scope so the
// store updater is not a function literal nested inside an async act callback.
function seedRemoteDraft(draftKey: string, text: string, version: number): void {
  useDraftStore.setState((previous) => ({
    drafts: {
      ...previous.drafts,
      [draftKey]: {
        input: { text, attachments: [] },
        lifecycle: "active",
        updatedAt: version * 100,
        version,
      } as unknown as DraftRecordForTest,
    },
  }));
}

// Mirrors a cleared/sent draft arriving from another device: an empty tombstone
// with a non-active lifecycle, as applyClearDraftRecord produces.
function sendDraftTombstone(draftKey: string): void {
  useDraftStore.setState((previous) => {
    const record = previous.drafts[draftKey];
    return {
      drafts: {
        ...previous.drafts,
        [draftKey]: {
          input: { text: "", attachments: [] },
          lifecycle: "sent",
          updatedAt: 9999,
          version: (record?.version ?? 0) + 1,
        } as unknown as DraftRecordForTest,
      },
    };
  });
}

// Writes a draft holding a single image attachment, mirroring how a synced draft
// (and later its locally materialized bytes) looks in the store. Version/updatedAt
// stay fixed so a metadata swap is not rejected as a stale write.
function setImageDraft(
  draftKey: string,
  input: { text: string; id: string; storageKey: string },
): void {
  useDraftStore.setState((previous) => ({
    drafts: {
      ...previous.drafts,
      [draftKey]: {
        input: {
          text: input.text,
          attachments: [
            {
              kind: "image",
              metadata: {
                id: input.id,
                mimeType: "image/png",
                storageType: "web-indexeddb",
                storageKey: input.storageKey,
                createdAt: 1,
              },
            },
          ],
        },
        lifecycle: "active",
        updatedAt: 500,
        version: 3,
      } as unknown as DraftRecordForTest,
    },
  }));
}

beforeAll(async () => {
  const storage = new Map<string, string>();

  Object.defineProperty(globalThis, "window", {
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        },
      },
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    value: true,
    configurable: true,
  });

  ({ useAgentInputDraft } = await import("./input-draft"));
});

describe("useAgentInputDraft live contract", () => {
  beforeEach(() => {
    asyncStorage.clear();
    const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
      url: "http://localhost",
    });

    Object.defineProperty(globalThis, "document", {
      value: dom.window.document,
      configurable: true,
    });
    Object.defineProperty(globalThis, "navigator", {
      value: dom.window.navigator,
      configurable: true,
    });

    useDraftStore.setState({ drafts: {}, createModalDraft: null });
  });

  it("hydrates persisted text and attachments and returns draft-mode composer state for a caller-provided key", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const image: AttachmentMetadata = {
      id: "attachment-1",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "attachments/1",
      createdAt: 1,
      fileName: "image.png",
      byteSize: 128,
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe({ draftKey }: { draftKey: string }) {
      latest = useAgentInputDraft({
        draftKey,
        composer: {
          initialServerId: "host-1",
          initialValues: { workingDir: "/repo" },
          isVisible: true,
          onlineServerIds: ["host-1"],
          lockedWorkingDir: "/repo",
        },
      });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    let root: Root | null = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Probe draftKey="draft:setup" />
        </QueryClientProvider>,
      );
    });

    expect(getLatest().composerState?.agentControls.selectedProvider).toBe("codex");
    expect(getLatest().composerState?.commandDraftConfig).toEqual({
      provider: "codex",
      cwd: "/repo",
      modeId: "auto",
      model: "gpt-5.4",
      thinkingOptionId: "high",
    });

    await act(async () => {
      getLatest().setText("hello world");
      getLatest().setAttachments([{ kind: "image", metadata: image }]);
    });

    await act(async () => {
      root!.unmount();
    });

    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe draftKey="draft:setup" />
        </QueryClientProvider>,
      );
    });

    expect(getLatest().text).toBe("hello world");
    expect(getLatest().attachments).toEqual([{ kind: "image", metadata: image }]);
  });

  it("migrates legacy image drafts to image attachments on hydration", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const image: AttachmentMetadata = {
      id: "legacy-image",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "attachments/legacy-image",
      createdAt: 10,
      fileName: "legacy.png",
      byteSize: 512,
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    useDraftStore.setState({
      drafts: {
        "draft:legacy": {
          input: {
            text: "legacy text",
            images: [image],
          },
          lifecycle: "active",
          updatedAt: Date.now(),
          version: 1,
        } as unknown as DraftRecordForTest,
      },
      createModalDraft: null,
    });

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:legacy" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    expect(getLatest().text).toBe("legacy text");
    expect(getLatest().attachments).toEqual([{ kind: "image", metadata: image }]);
    expect(useDraftStore.getState().drafts["draft:legacy"]?.input).toEqual({
      text: "legacy text",
      attachments: [{ kind: "image", metadata: image }],
    });
  });

  it("hydrates drafts saved by old builds with cwd", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const githubIssue: ComposerAttachment = {
      kind: "github_issue",
      item: {
        kind: "issue",
        number: 42,
        title: "Unify attachments",
        url: "https://github.com/paseo/paseo/issues/42",
        state: "open",
        body: "body",
        labels: ["composer"],
      },
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    useDraftStore.setState({
      drafts: {
        "draft:new-shape": {
          input: {
            text: "new text",
            attachments: [githubIssue],
            cwd: "/persisted",
          },
          lifecycle: "active",
          updatedAt: Date.now(),
          version: 1,
        } as unknown as DraftRecordForTest,
      },
      createModalDraft: null,
    });

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:new-shape" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    expect(getLatest().text).toBe("new text");
    expect(getLatest().attachments).toEqual([githubIssue]);

    await act(async () => {
      root.unmount();
    });

    expect(useDraftStore.getState().drafts["draft:new-shape"]?.input).toEqual({
      text: "new text",
      attachments: [githubIssue],
      cwd: "/persisted",
    });
  });

  it("updates and persists attachments through setAttachments", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const image: AttachmentMetadata = {
      id: "next-image",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "attachments/next-image",
      createdAt: 11,
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:attachments" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      getLatest().setText("with attachment");
      getLatest().setAttachments([{ kind: "image", metadata: image }]);
    });

    expect(getLatest().attachments).toEqual([{ kind: "image", metadata: image }]);
    expect(useDraftStore.getState().drafts["draft:attachments"]?.input).toEqual({
      text: "with attachment",
      attachments: [{ kind: "image", metadata: image }],
    });
  });

  it("clear resets text and attachments", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const image: AttachmentMetadata = {
      id: "clear-image",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "attachments/clear-image",
      createdAt: 12,
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:clear" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      getLatest().setText("queued message");
      getLatest().setAttachments([{ kind: "image", metadata: image }]);
    });

    await act(async () => {
      getLatest().clear("sent");
    });

    expect(getLatest().text).toBe("");
    expect(getLatest().attachments).toEqual([]);
    expect(useDraftStore.getState().drafts["draft:clear"]?.input).toEqual({
      text: "",
      attachments: [],
    });
  });

  it("adopts a remote draft change in place while the input is not focused", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:remote" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    // Simulate a cross-device update landing in the store from outside this
    // composer (as hydrateWorkspaceUiState does on a remote broadcast).
    await act(async () => {
      seedRemoteDraft("draft:remote", "from another device", 7);
    });

    expect(getLatest().text).toBe("from another device");
  });

  it("clears the composer when the draft is sent/cleared on another device", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:clear-sync" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      seedRemoteDraft("draft:clear-sync", "hello from other device", 5);
    });
    expect(getLatest().text).toBe("hello from other device");

    // The other device sends the message (or clears the field): a tombstone lands.
    await act(async () => {
      sendDraftTombstone("draft:clear-sync");
    });
    expect(getLatest().text).toBe("");
  });

  it("registers held attachment ids as live GC roots so the blob is not collected", async () => {
    const { collectLiveComposerAttachmentIds } = await import("@/attachments/live-attachment-refs");
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const image: AttachmentMetadata = {
      id: "live-root-image",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "live-root-image",
      createdAt: 1,
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:live-root" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      getLatest().setAttachments([{ kind: "image", metadata: image }]);
    });

    const liveIds = new Set<string>();
    collectLiveComposerAttachmentIds(liveIds);
    expect(liveIds.has("live-root-image")).toBe(true);

    // Unmounting releases the root so the blob can later be collected normally.
    await act(async () => {
      root.unmount();
    });
    const afterUnmount = new Set<string>();
    collectLiveComposerAttachmentIds(afterUnmount);
    expect(afterUnmount.has("live-root-image")).toBe(false);
  });

  it("keeps attachments the user just added while focused when a tombstone arrives", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const image: AttachmentMetadata = {
      id: "paste-guard-image",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "paste-guard-image",
      createdAt: 1,
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:paste-guard" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    // The user focuses the input and pastes/attaches an image.
    await act(async () => {
      getLatest().notifyInputFocus(true);
      getLatest().setAttachments([{ kind: "image", metadata: image }]);
    });
    expect(getLatest().attachments).toEqual([{ kind: "image", metadata: image }]);

    // A stale/echoed tombstone lands while the field is focused — it must NOT
    // yank the just-added attachment out from under the user.
    await act(async () => {
      sendDraftTombstone("draft:paste-guard");
    });
    expect(getLatest().attachments).toEqual([{ kind: "image", metadata: image }]);
  });

  it("adopts a materialized image attachment (storageKey swap) into an open composer", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:image" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    // A remote image draft lands with the SENDER's storageKey (not resolvable
    // locally yet).
    await act(async () => {
      setImageDraft("draft:image", { text: "look at this", id: "img-1", storageKey: "remote-key" });
    });

    expect(
      (getLatest().attachments[0] as { metadata: { storageKey: string } }).metadata.storageKey,
    ).toBe("remote-key");

    // materializeDraftImageBytes persists the bytes locally and rewrites the
    // attachment metadata to the local storageKey, preserving version/updatedAt.
    await act(async () => {
      setImageDraft("draft:image", { text: "look at this", id: "img-1", storageKey: "img-1" });
    });

    expect(
      (getLatest().attachments[0] as { metadata: { storageKey: string } }).metadata.storageKey,
    ).toBe("img-1");
  });

  it("adopts a materialized image attachment even while the input is focused (text stays deferred)", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:image-focused" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      setImageDraft("draft:image-focused", {
        text: "caption",
        id: "img-2",
        storageKey: "remote-key",
      });
    });

    // Focus the input, then a remote text change AND the image materialization
    // arrive together.
    await act(async () => {
      getLatest().notifyInputFocus(true);
    });

    await act(async () => {
      setImageDraft("draft:image-focused", {
        text: "remote caption while typing",
        id: "img-2",
        storageKey: "img-2",
      });
    });

    // The attachment (storageKey) is adopted even while focused, but the text is
    // NOT yanked out from under the typing user.
    expect(
      (getLatest().attachments[0] as { metadata: { storageKey: string } }).metadata.storageKey,
    ).toBe("img-2");
    expect(getLatest().text).toBe("caption");
  });

  it("defers a remote draft change while the input is focused, then adopts it on blur", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:focused" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      getLatest().notifyInputFocus(true);
    });

    await act(async () => {
      seedRemoteDraft("draft:focused", "remote while typing", 9);
    });

    // Focused: the remote value must not yank the input out from under typing.
    expect(getLatest().text).toBe("");

    await act(async () => {
      getLatest().notifyInputFocus(false);
    });

    // On blur we catch up to the deferred remote value.
    expect(getLatest().text).toBe("remote while typing");
  });

  it("clears drafts with sent and abandoned lifecycle tombstones", async () => {
    let latest: ReturnType<typeof useAgentInputDraft> | null = null;
    const sentImage: AttachmentMetadata = {
      id: "attachment-sent",
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: "attachments/sent",
      createdAt: 2,
    };

    function getLatest(): ReturnType<typeof useAgentInputDraft> {
      if (!latest) {
        throw new Error("Expected hook result");
      }
      return latest;
    }

    function Probe() {
      latest = useAgentInputDraft({ draftKey: "draft:lifecycle" });
      return null;
    }

    const queryClient = new QueryClient();
    const container = document.getElementById("root");
    if (!container) {
      throw new Error("Missing root container");
    }

    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      getLatest().setText("queued message");
      getLatest().setAttachments([{ kind: "image", metadata: sentImage }]);
    });

    await act(async () => {
      getLatest().clear("sent");
    });

    expect(getLatest().text).toBe("");
    expect(getLatest().attachments).toEqual([]);
    expect(useDraftStore.getState().drafts["draft:lifecycle"]).toMatchObject({
      lifecycle: "sent",
      input: { text: "", attachments: [] },
    });

    await act(async () => {
      getLatest().setText("draft again");
    });

    await act(async () => {
      getLatest().clear("abandoned");
    });

    expect(useDraftStore.getState().drafts["draft:lifecycle"]).toMatchObject({
      lifecycle: "abandoned",
      input: { text: "", attachments: [] },
    });
  });
});

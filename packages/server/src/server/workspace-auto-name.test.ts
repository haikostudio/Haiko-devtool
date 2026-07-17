import { describe, expect, it, vi } from "vitest";

import { WorkspaceAutoName } from "./workspace-auto-name.js";
import type { PersistedWorkspaceRecord } from "./workspace-registry.js";

function makeRecord(overrides: Partial<PersistedWorkspaceRecord> = {}): PersistedWorkspaceRecord {
  return {
    workspaceId: "ws-1",
    projectId: "proj-1",
    cwd: "/tmp/project",
    kind: "directory",
    displayName: "project",
    title: null,
    branch: null,
    baseBranch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

interface Harness {
  autoName: WorkspaceAutoName;
  upsert: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
  generate: ReturnType<typeof vi.fn>;
}

function makeHarness(input: {
  record: PersistedWorkspaceRecord | null;
  generatedTitle: string | null;
}): Harness {
  const record = input.record;
  const upsert = vi.fn(async () => {});
  const emit = vi.fn(async () => {});
  const generate = vi.fn(async () => ({ title: input.generatedTitle, branch: null }));
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };

  const autoName = new WorkspaceAutoName({
    // Only the message-rename path is exercised; the git/provider deps are handed
    // straight to the injected generator stub, so opaque casts are safe here.
    agentManager: {} as never,
    workspaceRegistry: {
      get: vi.fn(async () => record),
      upsert,
    },
    workspaceGitService: {} as never,
    providerSnapshotManager: {} as never,
    readDaemonConfig: () => ({ metadataGeneration: undefined }) as never,
    gitMutation: { notifyGitMutation: vi.fn(async () => {}) } as never,
    emitWorkspaceUpdateForCwd: vi.fn(async () => {}),
    emitWorkspaceUpdateForWorkspaceId: emit,
    logger: logger as never,
    generateWorkspaceName: generate as never,
  });

  return { autoName, upsert, emit, generate };
}

describe("WorkspaceAutoName.scheduleRenameFromMessage", () => {
  it("re-derives and persists the workspace title from the latest message", async () => {
    const { autoName, upsert, emit } = makeHarness({
      record: makeRecord({ title: "Old subject" }),
      generatedTitle: "New subject",
    });

    autoName.scheduleRenameFromMessage({
      workspaceId: "ws-1",
      cwd: "/tmp/project",
      message: "let's talk about the new subject",
    });

    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({ workspaceId: "ws-1", title: "New subject" });
    expect(emit).toHaveBeenCalledWith("ws-1");
  });

  it("never touches the git branch when renaming from a message", async () => {
    const { autoName, upsert } = makeHarness({
      record: makeRecord({ title: "Old", branch: "feature/keep-me" }),
      generatedTitle: "Fresh title",
    });

    autoName.scheduleRenameFromMessage({
      workspaceId: "ws-1",
      cwd: "/tmp/project",
      message: "change the subject",
    });

    await vi.waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({ branch: "feature/keep-me" });
  });

  it("skips the write when the generated title matches the current one", async () => {
    const { autoName, upsert, emit } = makeHarness({
      record: makeRecord({ title: "Same title" }),
      generatedTitle: "Same title",
    });

    autoName.scheduleRenameFromMessage({
      workspaceId: "ws-1",
      cwd: "/tmp/project",
      message: "no meaningful change",
    });

    await vi.waitFor(() => expect(true).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(upsert).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("ignores blank messages without invoking generation", async () => {
    const { autoName, generate, upsert } = makeHarness({
      record: makeRecord(),
      generatedTitle: "unused",
    });

    autoName.scheduleRenameFromMessage({
      workspaceId: "ws-1",
      cwd: "/tmp/project",
      message: "   ",
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(generate).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});

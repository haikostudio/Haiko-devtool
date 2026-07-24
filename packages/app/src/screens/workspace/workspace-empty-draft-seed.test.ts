import { describe, expect, it } from "vitest";
import {
  isWorkspaceEmpty,
  isWorkspaceReadyForEmptyDraftSeed,
  shouldSeedEmptyWorkspaceDraft,
} from "./workspace-empty-draft-seed";

const readyEmptyWorkspace = {
  isRouteFocused: true,
  hasPersistenceKey: true,
  hasWorkspaceDirectory: true,
  hasHydratedWorkspaceLayoutStore: true,
  hasHydratedAgents: true,
  hasLoadedTerminals: true,
  activeAgentCount: 0,
  terminalCount: 0,
  tabCount: 0,
};

describe("shouldSeedEmptyWorkspaceDraft", () => {
  it("waits for refresh-time hydration before seeding a draft", () => {
    expect(
      shouldSeedEmptyWorkspaceDraft({
        ...readyEmptyWorkspace,
        hasHydratedWorkspaceLayoutStore: false,
      }),
    ).toBe(false);
    expect(
      shouldSeedEmptyWorkspaceDraft({
        ...readyEmptyWorkspace,
        hasHydratedAgents: false,
      }),
    ).toBe(false);
    expect(
      shouldSeedEmptyWorkspaceDraft({
        ...readyEmptyWorkspace,
        hasLoadedTerminals: false,
      }),
    ).toBe(false);
  });

  it("does not seed when existing workspace content is known", () => {
    expect(
      shouldSeedEmptyWorkspaceDraft({
        ...readyEmptyWorkspace,
        activeAgentCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldSeedEmptyWorkspaceDraft({
        ...readyEmptyWorkspace,
        terminalCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldSeedEmptyWorkspaceDraft({
        ...readyEmptyWorkspace,
        tabCount: 1,
      }),
    ).toBe(false);
  });

  it("seeds once an empty focused workspace is fully known", () => {
    expect(shouldSeedEmptyWorkspaceDraft(readyEmptyWorkspace)).toBe(true);
  });
});

describe("isWorkspaceReadyForEmptyDraftSeed", () => {
  it("is ready only once every hydration gate has loaded", () => {
    expect(isWorkspaceReadyForEmptyDraftSeed(readyEmptyWorkspace)).toBe(true);
    // Readiness is independent of emptiness: a fully-hydrated workspace that
    // already has tabs is still "ready to decide".
    const readyWithTabs = { ...readyEmptyWorkspace, tabCount: 3 };
    expect(isWorkspaceReadyForEmptyDraftSeed(readyWithTabs)).toBe(true);
    expect(
      isWorkspaceReadyForEmptyDraftSeed({
        ...readyEmptyWorkspace,
        hasHydratedAgents: false,
      }),
    ).toBe(false);
  });
});

describe("isWorkspaceEmpty", () => {
  it("is empty only with no agents, terminals, or tabs", () => {
    expect(isWorkspaceEmpty({ activeAgentCount: 0, terminalCount: 0, tabCount: 0 })).toBe(true);
    expect(isWorkspaceEmpty({ activeAgentCount: 0, terminalCount: 0, tabCount: 1 })).toBe(false);
    expect(isWorkspaceEmpty({ activeAgentCount: 2, terminalCount: 0, tabCount: 0 })).toBe(false);
  });
});

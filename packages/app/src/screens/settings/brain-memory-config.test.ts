import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import {
  BRAIN_MEMORY_WARNING,
  createBrainMemoryPatch,
  getBrainMemoryCardState,
  getBrainMemoryMutationViewState,
} from "./brain-memory-config";

function makeConfig(brainMemoryEnabled = false): MutableDaemonConfig {
  return {
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    brainMemory: { enabled: brainMemoryEnabled },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  };
}

describe("brain memory opt-in config", () => {
  it("shows the card with the quota comparison warning when connected", () => {
    expect(getBrainMemoryCardState({ isConnected: true, config: makeConfig(false) })).toEqual({
      isVisible: true,
      isEnabled: false,
      title: "Cerveau",
      warning: BRAIN_MEMORY_WARNING,
    });
  });

  it("reads enabled state from daemon config", () => {
    expect(getBrainMemoryCardState({ isConnected: true, config: makeConfig(true) })).toMatchObject({
      isEnabled: true,
    });
  });

  it("hides the card when the host is disconnected", () => {
    expect(getBrainMemoryCardState({ isConnected: false, config: makeConfig(true) })).toMatchObject(
      {
        isVisible: false,
      },
    );
  });

  it("writes features.brainMemory.enabled when toggled", () => {
    expect(createBrainMemoryPatch(true)).toEqual({ brainMemory: { enabled: true } });
    expect(createBrainMemoryPatch(false)).toEqual({ brainMemory: { enabled: false } });
  });

  it("shows loading and disables the toggle while brain memory settings save", () => {
    expect(getBrainMemoryMutationViewState({ isPending: true, error: null })).toEqual({
      isSwitchDisabled: true,
      loadingText: "Updating brain memory…",
      errorText: null,
    });
  });

  it("shows the save error when brain memory settings fail", () => {
    expect(
      getBrainMemoryMutationViewState({ isPending: false, error: new Error("Disk full") }),
    ).toEqual({
      isSwitchDisabled: false,
      loadingText: null,
      errorText: "Disk full",
    });
  });
});

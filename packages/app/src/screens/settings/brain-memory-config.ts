import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

export const BRAIN_MEMORY_TITLE = "Cerveau";
export const BRAIN_MEMORY_WARNING =
  "Garde la mémoire longue durée disponible, mais coupe son usage pour comparer le quota consommé avec et sans aide mémoire.";

export interface BrainMemoryCardState {
  isVisible: boolean;
  isEnabled: boolean;
  title: string;
  warning: string;
}

export interface BrainMemoryMutationViewState {
  isSwitchDisabled: boolean;
  loadingText: string | null;
  errorText: string | null;
}

export function getBrainMemoryCardState(input: {
  isConnected: boolean;
  config: MutableDaemonConfig | null;
}): BrainMemoryCardState {
  return {
    isVisible: input.isConnected,
    isEnabled: readBrainMemoryEnabled(input.config),
    title: BRAIN_MEMORY_TITLE,
    warning: BRAIN_MEMORY_WARNING,
  };
}

export function createBrainMemoryPatch(enabled: boolean): Partial<MutableDaemonConfig> {
  return { brainMemory: { enabled } };
}

export function getBrainMemoryMutationViewState(input: {
  isPending: boolean;
  error: unknown;
}): BrainMemoryMutationViewState {
  return {
    isSwitchDisabled: input.isPending,
    loadingText: input.isPending ? "Updating brain memory…" : null,
    errorText: input.error ? toErrorMessage(input.error) : null,
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readBrainMemoryEnabled(config: MutableDaemonConfig | null): boolean {
  const brainMemory = config?.brainMemory;
  return (
    typeof brainMemory === "object" &&
    brainMemory !== null &&
    "enabled" in brainMemory &&
    brainMemory.enabled === true
  );
}

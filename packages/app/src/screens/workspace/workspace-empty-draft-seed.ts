// True once every input the seed decision depends on has loaded. Kept separate
// from emptiness so the caller can tell "not ready to decide yet" apart from
// "ready, and the workspace is not empty" — the two must NOT be conflated, or a
// user-initiated close (which momentarily empties the workspace) looks identical
// to a fresh empty-on-entry workspace and re-seeds a draft the user just closed.
export function isWorkspaceReadyForEmptyDraftSeed(input: {
  isRouteFocused: boolean;
  hasPersistenceKey: boolean;
  hasWorkspaceDirectory: boolean;
  hasHydratedWorkspaceLayoutStore: boolean;
  hasHydratedAgents: boolean;
  hasLoadedTerminals: boolean;
}): boolean {
  return (
    input.isRouteFocused &&
    input.hasPersistenceKey &&
    input.hasWorkspaceDirectory &&
    input.hasHydratedWorkspaceLayoutStore &&
    input.hasHydratedAgents &&
    input.hasLoadedTerminals
  );
}

export function isWorkspaceEmpty(input: {
  activeAgentCount: number;
  terminalCount: number;
  tabCount: number;
}): boolean {
  return input.activeAgentCount === 0 && input.terminalCount === 0 && input.tabCount === 0;
}

export function shouldSeedEmptyWorkspaceDraft(input: {
  isRouteFocused: boolean;
  hasPersistenceKey: boolean;
  hasWorkspaceDirectory: boolean;
  hasHydratedWorkspaceLayoutStore: boolean;
  hasHydratedAgents: boolean;
  hasLoadedTerminals: boolean;
  activeAgentCount: number;
  terminalCount: number;
  tabCount: number;
}): boolean {
  return isWorkspaceReadyForEmptyDraftSeed(input) && isWorkspaceEmpty(input);
}

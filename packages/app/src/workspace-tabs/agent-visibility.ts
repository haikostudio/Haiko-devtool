import type { Agent } from "@/stores/session-store";
import type { WorkspaceTabSnapshot } from "@/stores/workspace-layout-actions";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export interface WorkspaceAgentVisibility {
  activeAgentIds: Set<string>;
  autoOpenAgentIds: Set<string>;
  knownAgentIds: Set<string>;
  // Agents the host archived. Tracked separately from "not active" because a
  // PINNED agent is otherwise re-added from knownAgentIds, which kept an archived
  // agent's tab open forever — the reason archiving a task card never emptied the
  // tab band. Archiving wins over the pin.
  archivedAgentIds: Set<string>;
}

function agentBelongsToWorkspace(agent: Agent, workspaceId: string): boolean {
  return normalizeWorkspaceOpaqueId(agent.workspaceId) === workspaceId;
}

// Lazily-loaded historical agents: known to the workspace, never active. An
// archived one is recorded as such so a pin can't resurrect its tab.
function addHistoricalAgents(input: {
  agents: Map<string, Agent> | undefined;
  workspaceId: string;
  activeAgentIds: Set<string>;
  knownAgentIds: Set<string>;
  archivedAgentIds: Set<string>;
}): void {
  for (const agent of input.agents?.values() ?? []) {
    if (!agentBelongsToWorkspace(agent, input.workspaceId)) {
      continue;
    }
    input.knownAgentIds.add(agent.id);
    if (agent.archivedAt && !input.activeAgentIds.has(agent.id)) {
      input.archivedAgentIds.add(agent.id);
    }
  }
}

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaceId: string | null | undefined;
}): WorkspaceAgentVisibility {
  const { sessionAgents, agentDetails } = input;
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if ((!sessionAgents && !agentDetails) || !workspaceId) {
    return {
      activeAgentIds: new Set<string>(),
      autoOpenAgentIds: new Set<string>(),
      knownAgentIds: new Set<string>(),
      archivedAgentIds: new Set<string>(),
    };
  }

  const activeAgentIds = new Set<string>();
  const autoOpenAgentIds = new Set<string>();
  const knownAgentIds = new Set<string>();
  const archivedAgentIds = new Set<string>();
  const agentsById = new Map<string, Agent>([
    ...(agentDetails?.entries() ?? []),
    ...(sessionAgents?.entries() ?? []),
  ]);
  for (const agent of sessionAgents?.values() ?? []) {
    if (!agentBelongsToWorkspace(agent, workspaceId)) {
      continue;
    }
    knownAgentIds.add(agent.id);
    if (agent.archivedAt) {
      archivedAgentIds.add(agent.id);
    } else {
      activeAgentIds.add(agent.id);
      const parentAgent = agent.parentAgentId ? agentsById.get(agent.parentAgentId) : undefined;
      if (isWorkspaceRootAgent(agent, parentAgent)) {
        autoOpenAgentIds.add(agent.id);
      }
    }
  }
  addHistoricalAgents({
    agents: agentDetails,
    workspaceId,
    activeAgentIds,
    knownAgentIds,
    archivedAgentIds,
  });

  return { activeAgentIds, autoOpenAgentIds, knownAgentIds, archivedAgentIds };
}

// Remove agents that an in-flight create flow already owns through its draft tab
// from the auto-open set. Those agents retarget their draft tab in-place; letting
// auto-open surface them again produces a duplicate background tab. See the
// reconcile pass in workspace-screen for why the draft-tab gate alone can't cover
// this window.
export function excludeAutoOpenAgentIds(
  visibility: WorkspaceAgentVisibility,
  excludedAgentIds: ReadonlySet<string>,
): WorkspaceAgentVisibility {
  if (excludedAgentIds.size === 0) {
    return visibility;
  }
  const autoOpenAgentIds = new Set<string>();
  for (const agentId of visibility.autoOpenAgentIds) {
    if (!excludedAgentIds.has(agentId)) {
      autoOpenAgentIds.add(agentId);
    }
  }
  if (autoOpenAgentIds.size === visibility.autoOpenAgentIds.size) {
    return visibility;
  }
  return { ...visibility, autoOpenAgentIds };
}

export function buildWorkspaceTabSnapshot(input: {
  agentVisibility: WorkspaceAgentVisibility;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  knownTerminalIds: Iterable<string>;
  standaloneTerminalIds: Iterable<string>;
  hasActivePendingDraftCreate: boolean;
}): WorkspaceTabSnapshot {
  return {
    agentsHydrated: input.agentsHydrated,
    terminalsHydrated: input.terminalsHydrated,
    activeAgentIds: input.agentVisibility.activeAgentIds,
    autoOpenAgentIds: input.agentVisibility.autoOpenAgentIds,
    knownAgentIds: input.agentVisibility.knownAgentIds,
    archivedAgentIds: input.agentVisibility.archivedAgentIds,
    knownTerminalIds: input.knownTerminalIds,
    standaloneTerminalIds: input.standaloneTerminalIds,
    hasActivePendingDraftCreate: input.hasActivePendingDraftCreate,
  };
}

export function workspaceAgentVisibilityEqual(
  a: WorkspaceAgentVisibility,
  b: WorkspaceAgentVisibility,
): boolean {
  return (
    setsEqual(a.activeAgentIds, b.activeAgentIds) &&
    setsEqual(a.autoOpenAgentIds, b.autoOpenAgentIds) &&
    setsEqual(a.knownAgentIds, b.knownAgentIds) &&
    setsEqual(a.archivedAgentIds, b.archivedAgentIds)
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
}

// Prune agent tabs that are no longer active once agents are hydrated.
// Archived agents get pruned so that archiving on one client closes the tab on all clients.
export function shouldPruneWorkspaceAgentTab(input: {
  agentId: string;
  agentsHydrated: boolean;
  activeAgentIds: Set<string>;
}): boolean {
  if (!input.agentId.trim()) {
    return false;
  }
  if (!input.agentsHydrated) {
    return false;
  }
  return !input.activeAgentIds.has(input.agentId);
}

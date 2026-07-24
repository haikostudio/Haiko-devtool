export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

// Marks the persistent per-project "Chef d'orchestre" (conductor) agent. Used
// both to discover the existing conductor across restarts and to keep it out of
// the normal workspace tab/agent listings.
export const CONDUCTOR_ROLE_LABEL = "paseo.role";
export const CONDUCTOR_ROLE_VALUE = "conductor";
export const CONDUCTOR_PROJECT_ID_LABEL = "paseo.conductor-project-id";
export const CONDUCTOR_PROVIDER_LABEL = "paseo.conductor-provider";

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function isConductorAgent(agent: AgentLabelSource): boolean {
  return agent.labels?.[CONDUCTOR_ROLE_LABEL] === CONDUCTOR_ROLE_VALUE;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

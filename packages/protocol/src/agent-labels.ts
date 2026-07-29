export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

// Marks the persistent per-project "Chef d'orchestre" (conductor) agent. Used
// both to discover the existing conductor across restarts and to keep it out of
// the normal workspace tab/agent listings.
// `paseo.role` is the shared role key: the conductor carries "conductor", the
// grouped-deployment agent carries "deployment" (see DEPLOYMENT_ROLE_VALUE).
export const CONDUCTOR_ROLE_LABEL = "paseo.role";
export const CONDUCTOR_ROLE_VALUE = "conductor";
export const CONDUCTOR_PROJECT_ID_LABEL = "paseo.conductor-project-id";
export const CONDUCTOR_PROVIDER_LABEL = "paseo.conductor-provider";

// Marks the single grouped-deployment agent that publishes every queued card of
// the "À déployer" column in one batch. Routed to its own response template so
// its answer reads as a batch publication log, and openable by the user to watch
// the run live. Shares the `paseo.role` key above.
export const DEPLOYMENT_ROLE_VALUE = "deployment";

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function isConductorAgent(agent: AgentLabelSource): boolean {
  return agent.labels?.[CONDUCTOR_ROLE_LABEL] === CONDUCTOR_ROLE_VALUE;
}

export function isDeploymentAgent(agent: AgentLabelSource): boolean {
  return agent.labels?.[CONDUCTOR_ROLE_LABEL] === DEPLOYMENT_ROLE_VALUE;
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

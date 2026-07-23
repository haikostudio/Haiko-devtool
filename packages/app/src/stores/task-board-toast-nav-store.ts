import { create } from "zustand";

// While the tasks board is on screen it publishes a resolver here so the global
// agent-task toast stack can behave contextually: a toast tap opens the matching
// task's drawer (exactly like tapping its card) instead of navigating to the raw
// agent conversation. When no board is mounted the resolver is null and the toast
// falls back to opening the agent — the plain "base interface" behaviour.

export interface AgentTaskTarget {
  serverId: string;
  agentId: string;
}

// Returns true when the board recognized the agent as one of its tasks and opened
// that task's drawer; false when it did not (agent belongs to another project or
// host — the toast then navigates to the agent instead).
export type AgentTaskResolver = (target: AgentTaskTarget) => boolean;

interface TaskBoardToastNavState {
  resolveAgentTask: AgentTaskResolver | null;
  setResolveAgentTask: (resolver: AgentTaskResolver | null) => void;
}

export const useTaskBoardToastNavStore = create<TaskBoardToastNavState>((set) => ({
  resolveAgentTask: null,
  setResolveAgentTask: (resolveAgentTask) => set({ resolveAgentTask }),
}));

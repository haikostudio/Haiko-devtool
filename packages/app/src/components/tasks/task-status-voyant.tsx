import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  deriveAgentStateBucket,
  type WorkspaceStateBucket,
} from "@getpaseo/protocol/agent-state-bucket";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { KanbanTask } from "@/data/tasks";
import { aggregateTaskTones, deriveTaskTone, taskAgentId, type TaskTone } from "./task-status-tone";

// Live agentId → status-bucket lookup shared across the tasks screen. Built once
// at the screen root so the project rail, folder rail, and every task card read
// the same up-to-date agent state without each subscribing to the agent list.
const AgentBucketContext = createContext<Map<string, WorkspaceStateBucket>>(new Map());

/**
 * Provides the agentId → bucket map to the tasks screen. Rebuilds only when the
 * aggregated agents change (the hook preserves array identity otherwise), so the
 * map reference is stable across unrelated re-renders.
 */
export function AgentBucketProvider({ children }: { children: ReactNode }): ReactElement {
  const { agents } = useAggregatedAgents();
  const map = useMemo(() => {
    const next = new Map<string, WorkspaceStateBucket>();
    for (const agent of agents) {
      next.set(
        agent.id,
        deriveAgentStateBucket({
          status: agent.status,
          pendingPermissionCount: agent.pendingPermissionCount,
          requiresAttention: agent.requiresAttention,
          attentionReason: agent.attentionReason,
        }),
      );
    }
    return next;
  }, [agents]);
  return <AgentBucketContext.Provider value={map}>{children}</AgentBucketContext.Provider>;
}

function useAgentBucketMap(): Map<string, WorkspaceStateBucket> {
  return useContext(AgentBucketContext);
}

// Tone for a single task, reflecting its board fields plus its live agent state.
export function useTaskTone(task: KanbanTask): TaskTone | null {
  const map = useAgentBucketMap();
  const agentId = taskAgentId(task);
  const bucket = agentId ? map.get(agentId) : undefined;
  return useMemo(() => deriveTaskTone(task, bucket), [task, bucket]);
}

// Aggregate tone for a folder/project card, rolled up from its tasks' live tones.
export function useAggregateTone(tasks: KanbanTask[]): TaskTone | null {
  const map = useAgentBucketMap();
  return useMemo(() => {
    const tones = tasks.map((task) => {
      const agentId = taskAgentId(task);
      return deriveTaskTone(task, agentId ? map.get(agentId) : undefined);
    });
    return aggregateTaskTones(tones);
  }, [tasks, map]);
}

function toneOf(task: KanbanTask, map: Map<string, WorkspaceStateBucket>): TaskTone | null {
  const agentId = taskAgentId(task);
  return deriveTaskTone(task, agentId ? map.get(agentId) : undefined);
}

// Groups a project's live tasks by folder and rolls each folder up to one tone.
// Keyed by folderId. Used by the folder rails, which already hold the live board.
export function useFolderToneMap(tasks: KanbanTask[]): Map<string, TaskTone | null> {
  const map = useAgentBucketMap();
  return useMemo(() => {
    const byFolder = new Map<string, TaskTone[]>();
    for (const task of tasks) {
      const tone = toneOf(task, map);
      if (tone === null) {
        continue;
      }
      const list = byFolder.get(task.folderId);
      if (list) {
        list.push(tone);
      } else {
        byFolder.set(task.folderId, [tone]);
      }
    }
    const result = new Map<string, TaskTone | null>();
    for (const [folderId, tones] of byFolder) {
      result.set(folderId, aggregateTaskTones(tones));
    }
    return result;
  }, [tasks, map]);
}

interface ProjectRef {
  serverId: string;
  projectId: string;
}

function projectRefKey(ref: ProjectRef): string {
  return `${ref.serverId}:${ref.projectId}`;
}

/**
 * Aggregate tone per project, keyed by "serverId:projectId". One-shot fetches
 * each project's board (the project rail has no live subscription) whenever the
 * set of projects changes, then rolls the tasks up against the live agent state
 * — so the agent-driven signals (waiting / running) stay current between fetches.
 */
export function useProjectToneMap(projects: ProjectRef[]): Map<string, TaskTone | null> {
  const bucketMap = useAgentBucketMap();
  const [tasksByProject, setTasksByProject] = useState<Map<string, KanbanTask[]>>(() => new Map());
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const projectKey = useMemo(() => projects.map(projectRefKey).join("|"), [projects]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const store = getHostRuntimeStore();
      const next = new Map<string, KanbanTask[]>();
      await Promise.all(
        projectsRef.current.map(async (ref) => {
          const client = store.getClient(ref.serverId);
          if (!client) {
            return;
          }
          try {
            const payload = await client.tasksBoardGet(ref.projectId);
            if (payload.board) {
              next.set(projectRefKey(ref), payload.board.tasks);
            }
          } catch {
            // Host may not support tasks or be disconnected — skip silently.
          }
        }),
      );
      if (!cancelled) {
        setTasksByProject(next);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectKey]);

  return useMemo(() => {
    const result = new Map<string, TaskTone | null>();
    for (const [key, tasks] of tasksByProject) {
      result.set(key, aggregateTaskTones(tasks.map((task) => toneOf(task, bucketMap))));
    }
    return result;
  }, [tasksByProject, bucketMap]);
}

/**
 * The status "voyant": a small colored dot. `dot` sits inline in a rail row;
 * `pip` straddles the top-left corner of a card, echoing the agent toast badge.
 * Renders nothing when there is no tone to show.
 */
export function TaskStatusVoyant({
  tone,
  variant = "dot",
}: {
  tone: TaskTone | null;
  variant?: "dot" | "pip";
}): ReactElement | null {
  const { t } = useTranslation();
  if (!tone) {
    return null;
  }
  return (
    <View style={VOYANT_STYLE[variant][tone]} accessibilityLabel={t(`tasks.status.${tone}`)} />
  );
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: 9,
    height: 9,
    borderRadius: theme.borderRadius.full,
  },
  // Straddles the card's top-left corner (half outside, overlapping the border),
  // ringed by the card surface so it reads as a distinct light — same treatment
  // as the agent toast pip.
  pip: {
    position: "absolute",
    top: -5,
    left: -5,
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: theme.colors.surface0,
    zIndex: 2,
  },
  toneAttention: {
    backgroundColor: theme.colors.palette.amber[500],
  },
  toneRunning: {
    backgroundColor: theme.colors.palette.blue[500],
  },
  toneDone: {
    backgroundColor: theme.colors.palette.green[500],
  },
}));

const TONE_STYLE: Record<TaskTone, object> = {
  attention: styles.toneAttention,
  running: styles.toneRunning,
  done: styles.toneDone,
};

// Precomputed [shape, tone] style tuples so the render passes a stable array
// reference instead of building a new one each time (react-perf lint rule).
const VOYANT_STYLE: Record<"dot" | "pip", Record<TaskTone, object[]>> = {
  dot: {
    attention: [styles.dot, TONE_STYLE.attention],
    running: [styles.dot, TONE_STYLE.running],
    done: [styles.dot, TONE_STYLE.done],
  },
  pip: {
    attention: [styles.pip, TONE_STYLE.attention],
    running: [styles.pip, TONE_STYLE.running],
    done: [styles.pip, TONE_STYLE.done],
  },
};

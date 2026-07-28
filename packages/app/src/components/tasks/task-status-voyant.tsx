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
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  deriveAgentStateBucket,
  type WorkspaceStateBucket,
} from "@getpaseo/protocol/agent-state-bucket";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { SyncedLoader } from "@/components/synced-loader";
import type { KanbanTask } from "@/data/tasks";
import { aggregateTaskTones, deriveTaskTone, taskAgentId, type TaskTone } from "./task-status-tone";

// Everything a card needs to know about its live agent: the coarse status
// bucket, plus whether the agent's last message actually asks the user
// something (the daemon's deterministic read of the transcript). Kept together
// so a card never has to guess a pending question from a lifecycle flag.
interface AgentSignal {
  bucket: WorkspaceStateBucket;
  awaitsUser: boolean;
}

// Live agentId → signal lookup shared across the tasks screen. Built once at the
// screen root so the project rail, folder rail, and every task card read the
// same up-to-date agent state without each subscribing to the agent list.
const AgentBucketContext = createContext<Map<string, AgentSignal>>(new Map());

/**
 * Provides the agentId → bucket map to the tasks screen. Rebuilds only when the
 * aggregated agents change (the hook preserves array identity otherwise), so the
 * map reference is stable across unrelated re-renders.
 */
export function AgentBucketProvider({ children }: { children: ReactNode }): ReactElement {
  const { agents } = useAggregatedAgents();
  const map = useMemo(() => {
    const next = new Map<string, AgentSignal>();
    for (const agent of agents) {
      next.set(agent.id, {
        bucket: deriveAgentStateBucket({
          status: agent.status,
          pendingPermissionCount: agent.pendingPermissionCount,
          requiresAttention: agent.requiresAttention,
          attentionReason: agent.attentionReason,
        }),
        awaitsUser: agent.awaitsUser === true,
      });
    }
    return next;
  }, [agents]);
  return <AgentBucketContext.Provider value={map}>{children}</AgentBucketContext.Provider>;
}

function useAgentBucketMap(): Map<string, AgentSignal> {
  return useContext(AgentBucketContext);
}

// Tone for a single task, reflecting its board fields plus its live agent state.
export function useTaskTone(task: KanbanTask): TaskTone | null {
  const map = useAgentBucketMap();
  const agentId = taskAgentId(task);
  const signal = agentId ? map.get(agentId) : undefined;
  // Depend on the primitives, not the signal object: the map is rebuilt whenever
  // the agent list changes, and re-deriving on an unchanged state is pure waste.
  const bucket = signal?.bucket;
  const awaitsUser = signal?.awaitsUser;
  return useMemo(() => deriveTaskTone(task, bucket, awaitsUser), [task, bucket, awaitsUser]);
}

// Aggregate tone for a folder/project card, rolled up from its tasks' live tones.
export function useAggregateTone(tasks: KanbanTask[]): TaskTone | null {
  const map = useAgentBucketMap();
  return useMemo(() => aggregateTaskTones(tasks.map((task) => toneOf(task, map))), [tasks, map]);
}

function toneOf(task: KanbanTask, map: Map<string, AgentSignal>): TaskTone | null {
  const agentId = taskAgentId(task);
  const signal = agentId ? map.get(agentId) : undefined;
  return deriveTaskTone(task, signal?.bucket, signal?.awaitsUser);
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

// The project rail has no live board subscription, so it can't see a task move
// into "in progress" the moment it starts. Re-poll every few seconds so a
// project's dot lights up when a descendant starts working — and, just as
// importantly, goes quiet again once nothing is left running.
const PROJECT_TONE_POLL_MS = 4000;

// The board of the project the user is currently viewing (already live-subscribed
// elsewhere). Overlaid onto the polled snapshot so the selected project's dot
// reacts instantly, with no poll delay.
export interface LiveProjectBoard {
  key: string;
  tasks: KanbanTask[];
}

/**
 * Aggregate tone per project, keyed by "serverId:projectId". Fetches each
 * project's board (the project rail has no live subscription) whenever the set of
 * projects changes, then keeps polling on an interval so state that lives on the
 * board (a task entering the in-progress column, a schedule launching) surfaces
 * on the parent project — not just the live agent signals. `liveBoard`, when
 * given, overrides the polled snapshot for the currently-viewed project so its
 * dot animates the instant a child starts.
 */
export function useProjectToneMap(
  projects: ProjectRef[],
  liveBoard?: LiveProjectBoard | null,
): Map<string, TaskTone | null> {
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
    const timer = setInterval(load, PROJECT_TONE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectKey]);

  return useMemo(() => {
    const result = new Map<string, TaskTone | null>();
    for (const [key, tasks] of tasksByProject) {
      result.set(key, aggregateTaskTones(tasks.map((task) => toneOf(task, bucketMap))));
    }
    // The viewed project's live board wins over its (possibly stale) polled copy.
    if (liveBoard) {
      result.set(
        liveBoard.key,
        aggregateTaskTones(liveBoard.tasks.map((task) => toneOf(task, bucketMap))),
      );
    }
    return result;
  }, [tasksByProject, bucketMap, liveBoard]);
}

// Vertical hop (px) of the attention bounce, and how often it repeats — kept in
// step with the card's attention shake so the light and the card pulse together.
const BOUNCE_LIFT = 3;
const BOUNCE_INTERVAL_MS = 5000;

/**
 * Drives the "waiting for you" bounce on the amber light: a light up-and-settle
 * hop (~0.4s) followed by a rest, looping every `BOUNCE_INTERVAL_MS`. Returns an
 * animated transform to spread on the dot. Disabled (identity transform) when the
 * OS asks for reduced motion. Only mounted for the `attention` tone, so the hook
 * runs solely while the light is actually waiting.
 */
function useAttentionBounce() {
  const offset = useSharedValue(0);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) {
      offset.value = 0;
      return;
    }
    // One hop: lift up, overshoot back down a touch, then settle — mirrors the
    // card shake's burst-then-hold cadence, just on the vertical axis.
    const burst = withSequence(
      withTiming(-1, { duration: 150 }),
      withTiming(0.25, { duration: 130 }),
      withTiming(0, { duration: 110 }),
    );
    offset.value = withRepeat(withDelay(BOUNCE_INTERVAL_MS - 390, burst), -1, false);
    return () => {
      cancelAnimation(offset);
      offset.value = 0;
    };
  }, [reduceMotion, offset]);

  return useAnimatedStyle(() => ({
    transform: [{ translateY: offset.value * BOUNCE_LIFT }],
  }));
}

// The amber "wants you" light, isolated into its own component so the bounce
// hooks only run while an attention light is actually on screen (the parent bails
// out early for the null / running / static tones).
function AttentionLight({
  variant,
  label,
}: {
  variant: "dot" | "pip";
  label: string;
}): ReactElement {
  const bounceStyle = useAttentionBounce();
  // Memoized so the combined [static, animated] array keeps a stable reference
  // across renders (react-perf/jsx-no-new-array-as-prop). `bounceStyle` from
  // useAnimatedStyle is itself stable, so this only rebuilds when the variant flips.
  const style = useMemo(
    () => [VOYANT_STYLE[variant].attention, bounceStyle],
    [variant, bounceStyle],
  );
  return <Animated.View style={style} accessibilityLabel={label} />;
}

/**
 * The status "voyant": echoes the agent toast badge. A `running` task shows the
 * exact same shared square loader as the toasts (a spinning dot grid); the
 * `attention` light gives a light bounce to say it wants a reply (like the
 * sidebar dot); the rest are small static colored lights — blue = scheduled,
 * green = done. `dot` sits inline in a rail row; `pip` straddles the top-left
 * corner of a card. Renders nothing when there is no tone to show.
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
  const label = t(`tasks.status.${tone}`);
  // Actively working: the same synced square loader the agent toasts use, so the
  // "en cours" light animates identically everywhere it appears.
  if (tone === "running") {
    return (
      <View style={LOADER_WRAP_STYLE[variant]} accessibilityLabel={label}>
        <SyncedLoader size={LOADER_SIZE[variant]} color={styles.loaderColor.color} />
      </View>
    );
  }
  // Waiting for a reply: the amber light bounces, echoing the card's shake.
  if (tone === "attention") {
    return <AttentionLight variant={variant} label={label} />;
  }
  return <View style={VOYANT_STYLE[variant][tone]} accessibilityLabel={label} />;
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
  // Inline wrapper that centers the square loader where a rail dot would sit.
  loaderDot: {
    width: 11,
    height: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  // Straddles the card corner exactly where the `pip` dot would, so swapping the
  // static light for the animated loader keeps the same anchor.
  loaderPip: {
    position: "absolute",
    top: -4,
    left: -4,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  // The loader color reads as "working" blue — same lane as the scheduled light,
  // but animated. Pulled off the stylesheet so SyncedLoader gets a plain string.
  loaderColor: {
    color: theme.colors.palette.blue[500],
  },
  toneAttention: {
    backgroundColor: theme.colors.palette.amber[500],
  },
  toneScheduled: {
    backgroundColor: theme.colors.palette.blue[500],
  },
  toneDone: {
    backgroundColor: theme.colors.palette.green[500],
  },
}));

// Loader dimensions per variant: a touch larger on cards (pip) than in rail rows.
const LOADER_SIZE: Record<"dot" | "pip", number> = {
  dot: 10,
  pip: 12,
};

const LOADER_WRAP_STYLE: Record<"dot" | "pip", object> = {
  dot: styles.loaderDot,
  pip: styles.loaderPip,
};

// Static tones only — `running` is drawn by the SyncedLoader, not a colored dot.
type StaticTone = Exclude<TaskTone, "running">;

const TONE_STYLE: Record<StaticTone, object> = {
  attention: styles.toneAttention,
  scheduled: styles.toneScheduled,
  done: styles.toneDone,
};

// Precomputed [shape, tone] style tuples so the render passes a stable array
// reference instead of building a new one each time (react-perf lint rule).
const VOYANT_STYLE: Record<"dot" | "pip", Record<StaticTone, object[]>> = {
  dot: {
    attention: [styles.dot, TONE_STYLE.attention],
    scheduled: [styles.dot, TONE_STYLE.scheduled],
    done: [styles.dot, TONE_STYLE.done],
  },
  pip: {
    attention: [styles.pip, TONE_STYLE.attention],
    scheduled: [styles.pip, TONE_STYLE.scheduled],
    done: [styles.pip, TONE_STYLE.done],
  },
};

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
import { useOptimisticTaskActionStore } from "@/stores/optimistic-task-action-store";
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
  // A boolean selector: this card re-renders only when ITS own flag flips, not
  // when any other card's action starts or clears.
  const optimisticPending = useOptimisticTaskActionStore((state) => state.pendingIds.has(task.id));
  return useMemo(
    () => deriveTaskTone(task, bucket, awaitsUser, optimisticPending),
    [task, bucket, awaitsUser, optimisticPending],
  );
}

// Aggregate tone for a folder/project card, rolled up from its tasks' live tones.
export function useAggregateTone(tasks: KanbanTask[]): TaskTone | null {
  const map = useAgentBucketMap();
  const pendingIds = useOptimisticTaskActionStore((state) => state.pendingIds);
  return useMemo(
    () => aggregateTaskTones(tasks.map((task) => toneOf(task, map, pendingIds))),
    [tasks, map, pendingIds],
  );
}

function toneOf(
  task: KanbanTask,
  map: Map<string, AgentSignal>,
  pendingIds?: ReadonlySet<string>,
): TaskTone | null {
  const agentId = taskAgentId(task);
  const signal = agentId ? map.get(agentId) : undefined;
  return deriveTaskTone(task, signal?.bucket, signal?.awaitsUser, pendingIds?.has(task.id));
}

// Groups a project's live tasks by folder and rolls each folder up to one tone.
// Keyed by folderId. Used by the folder rails, which already hold the live board.
export function useFolderToneMap(tasks: KanbanTask[]): Map<string, TaskTone | null> {
  const map = useAgentBucketMap();
  const pendingIds = useOptimisticTaskActionStore((state) => state.pendingIds);
  return useMemo(() => {
    const byFolder = new Map<string, TaskTone[]>();
    for (const task of tasks) {
      const tone = toneOf(task, map, pendingIds);
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
  }, [tasks, map, pendingIds]);
}

interface ProjectRef {
  serverId: string;
  projectId: string;
}

function projectRefKey(ref: ProjectRef): string {
  return `${ref.serverId}:${ref.projectId}`;
}

function railSubscriptionId(key: string): string {
  return `rail-${key}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Live tasks of EVERY project in the rail, keyed by "serverId:projectId".
 *
 * One board subscription per project, so a card starting, finishing or asking
 * the user something lights its project's dot the instant it happens — the rail
 * is the one place in the app that must speak for projects the user is not
 * looking at.
 *
 * This used to be a poll: every project's full board re-fetched every four
 * seconds, forever, whether or not anything had changed. On a host with twenty
 * projects that alone was five requests a second against the daemon, enough to
 * push board pushes seconds late and make the very indicators it fed lag. A
 * subscription costs one snapshot at mount and then nothing until a board
 * actually changes.
 */
export function useProjectBoardTasks(projects: ProjectRef[]): Map<string, KanbanTask[]> {
  const [tasksByProject, setTasksByProject] = useState<Map<string, KanbanTask[]>>(() => new Map());
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const projectKey = useMemo(() => projects.map(projectRefKey).join("|"), [projects]);

  useEffect(() => {
    const store = getHostRuntimeStore();
    const refs = projectsRef.current;
    const live = new Set(refs.map(projectRefKey));
    // A project that left the rail must not keep lighting a dot from its last
    // known board.
    setTasksByProject((prev) => {
      const next = new Map<string, KanbanTask[]>();
      for (const [key, tasks] of prev) {
        if (live.has(key)) {
          next.set(key, tasks);
        }
      }
      return next.size === prev.size ? prev : next;
    });

    const disposers: Array<() => void> = [];
    for (const ref of refs) {
      const client = store.getClient(ref.serverId);
      if (!client) {
        continue;
      }
      const key = projectRefKey(ref);
      const subscriptionId = railSubscriptionId(key);
      // Registered before subscribing: the daemon answers a subscription with an
      // immediate snapshot on this very channel, which is our initial load.
      disposers.push(
        client.on("tasks.board.update", (message) => {
          if (message.payload.subscriptionId !== subscriptionId) {
            return;
          }
          const tasks = message.payload.board.tasks;
          setTasksByProject((prev) => {
            const next = new Map(prev);
            next.set(key, tasks);
            return next;
          });
        }),
      );
      // Host may not support tasks or be disconnected — a rail dot is never worth
      // an error.
      void client.tasksBoardSubscribe(ref.projectId, subscriptionId).catch(() => {});
      disposers.push(() => {
        void client.tasksBoardUnsubscribe(subscriptionId).catch(() => {});
      });
    }
    return () => {
      for (const dispose of disposers) {
        dispose();
      }
    };
  }, [projectKey]);

  return tasksByProject;
}

// The board of the project the user is currently viewing (already live-subscribed
// elsewhere). Overlaid onto the polled snapshot so the selected project's dot
// reacts instantly, with no poll delay.
export interface LiveProjectBoard {
  key: string;
  tasks: KanbanTask[];
}

/**
 * Aggregate tone per project, keyed by "serverId:projectId", rolled up from the
 * live boards of every project in the rail and the live state of their agents.
 *
 * `liveBoard`, when given, overrides the subscribed copy for the project the
 * user is actually viewing: that board carries the optimistic overlay of a move
 * still in flight, which no push knows about yet.
 */
export function useProjectToneMap(
  tasksByProject: Map<string, KanbanTask[]>,
  liveBoard?: LiveProjectBoard | null,
): Map<string, TaskTone | null> {
  const bucketMap = useAgentBucketMap();
  // An action the user just fired lights the parent project too, instead of
  // leaving the rail dark until the server answers.
  const pendingIds = useOptimisticTaskActionStore((state) => state.pendingIds);

  return useMemo(() => {
    const result = new Map<string, TaskTone | null>();
    for (const [key, tasks] of tasksByProject) {
      result.set(key, aggregateTaskTones(tasks.map((task) => toneOf(task, bucketMap, pendingIds))));
    }
    if (liveBoard) {
      result.set(
        liveBoard.key,
        aggregateTaskTones(liveBoard.tasks.map((task) => toneOf(task, bucketMap, pendingIds))),
      );
    }
    return result;
  }, [tasksByProject, bucketMap, pendingIds, liveBoard]);
}

// Vertical hop (px) of the attention bounce, and how often it repeats — kept in
// step with the card's attention shake so the light and the card pulse together.
const BOUNCE_LIFT = 3;
const BOUNCE_INTERVAL_MS = 3000;

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

// How dim the pending light dips at the bottom of its breath, and how long one
// half-breath lasts — a slow, calm pulse that reads as "warming up" without the
// urgency of the running spinner or the attention bounce.
const PENDING_MIN_OPACITY = 0.35;
const PENDING_BREATH_MS = 850;

/**
 * Drives the slow breathing pulse on the "En attente d'exécution" light: opacity
 * eases down to `PENDING_MIN_OPACITY` and back, looping. Returns an animated
 * style to spread on the dot. Disabled (full opacity, no motion) when the OS asks
 * for reduced motion. Only mounted for the `pending` tone.
 */
function usePendingPulse() {
  const opacity = useSharedValue(1);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withSequence(
        withTiming(PENDING_MIN_OPACITY, { duration: PENDING_BREATH_MS }),
        withTiming(1, { duration: PENDING_BREATH_MS }),
      ),
      -1,
      false,
    );
    return () => {
      cancelAnimation(opacity);
      opacity.value = 1;
    };
  }, [reduceMotion, opacity]);

  return useAnimatedStyle(() => ({ opacity: opacity.value }));
}

// The teal "spinning up" light, isolated so the pulse hooks only run while a
// pending light is actually on screen (the parent bails out early otherwise).
function PendingLight({ variant, label }: { variant: "dot" | "pip"; label: string }): ReactElement {
  const pulseStyle = usePendingPulse();
  const style = useMemo(() => [voyantStyle(variant, "pending"), pulseStyle], [variant, pulseStyle]);
  return <Animated.View style={style} accessibilityLabel={label} />;
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
    () => [voyantStyle(variant, "attention"), bounceStyle],
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
      <View style={loaderWrapStyle(variant)} accessibilityLabel={label}>
        <SyncedLoader size={LOADER_SIZE[variant]} color={styles.loaderColor.color} />
      </View>
    );
  }
  // Launched, agent spinning up: a slow teal breath — "En attente d'exécution".
  if (tone === "pending") {
    return <PendingLight variant={variant} label={label} />;
  }
  // Waiting for a reply: the amber light bounces, echoing the card's shake.
  if (tone === "attention") {
    return <AttentionLight variant={variant} label={label} />;
  }
  return <View style={voyantStyle(variant, tone)} accessibilityLabel={label} />;
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
  tonePending: {
    backgroundColor: theme.colors.palette.teal[500],
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

// Built at render time (not materialized at module load) so the `styles.*`
// Unistyles proxies resolve against the live theme and repaint on light/dark
// toggle without a reload.
function loaderWrapStyle(variant: "dot" | "pip"): object {
  return variant === "pip" ? styles.loaderPip : styles.loaderDot;
}

// Static tones only — `running` is drawn by the SyncedLoader, not a colored dot.
type StaticTone = Exclude<TaskTone, "running">;

function toneStyle(tone: StaticTone): object {
  switch (tone) {
    case "attention":
      return styles.toneAttention;
    case "pending":
      return styles.tonePending;
    case "scheduled":
      return styles.toneScheduled;
    default:
      return styles.toneDone;
  }
}

// [shape, tone] style tuple resolved per render.
function voyantStyle(variant: "dot" | "pip", tone: StaticTone): object[] {
  return [variant === "pip" ? styles.pip : styles.dot, toneStyle(tone)];
}

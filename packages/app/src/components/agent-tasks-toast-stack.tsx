import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import {
  type LayoutChangeEvent,
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { ChevronsDownUp, ChevronsUpDown, GripVertical } from "lucide-react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, {
  type AnimatedStyle,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  deriveAgentStateBucket,
  type WorkspaceStateBucket,
} from "@getpaseo/protocol/agent-state-bucket";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  type DraggableToast,
  useDraggableToast,
  useToastSection,
} from "@/hooks/use-draggable-toast";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { getProviderIcon } from "@/components/provider-icons";
import { SyncedLoader } from "@/components/synced-loader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { formatDuration, formatMessageTimestamp } from "@/utils/time";
import { agentTaskToastKey, useAgentTaskToastStore } from "@/stores/agent-task-toast-store";
import { useTaskBoardToastNavStore } from "@/stores/task-board-toast-nav-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import {
  collectAllPanes,
  collectAllTabs,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

const ICON_SIZE = 16;
// Matches theme.spacing[4]; kept as a literal so the container can add the
// safe-area inset without subscribing the whole component to the theme runtime.
// Matches the horizontal RAIL_CLEARANCE so the pile keeps the same breathing room
// from the bottom edge as it does from the right — otherwise it reads as flush to
// the bottom while the sides have a clear gap.
const BASE_BOTTOM_OFFSET = 44;
// The magic scrollbar rail lives at right:12 with a 20px width, so it occupies
// the rightmost ~32px of the pane. Offset the toast stack past it (plus a small
// gap) so the rail stays visible instead of hiding behind the toasts.
const RAIL_CLEARANCE = 44;
// How much of each card behind the front one peeks out at the top when the stack
// is collapsed into a pile — just enough to show the status pip and a sliver.
const COLLAPSED_PEEK = 10;
// When collapsed, the pile fades into the distance: the front card is fully opaque
// and each card further back drops one step, floored so its status pip still reads.
const COLLAPSED_OPACITY_STEP = 0.18;
const COLLAPSED_MIN_OPACITY = 0.35;
// Once this many toasts are tracked, the pile folds itself by default (until the
// user overrides it with the toggle). Keeps a busy corner from taking over.
const AUTO_COLLAPSE_COUNT = 4;
// Fold/unfold timing — short enough to feel snappy, long enough to read as motion.
const FOLD_DURATION_MS = 220;

export interface TrackedTask {
  key: string;
  agent: AggregatedAgent;
  bucket: WorkspaceStateBucket;
}

function bucketOf(agent: AggregatedAgent): WorkspaceStateBucket {
  return deriveAgentStateBucket({
    status: agent.status,
    pendingPermissionCount: agent.pendingPermissionCount,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
  });
}

// Groups the five status buckets into the three lifecycle lanes the stack sorts by:
// waiting-for-user (top) → running (middle) → finished (bottom, nearest the corner).
// Lower rank renders higher up the column.
const BUCKET_GROUP_RANK: Record<WorkspaceStateBucket, number> = {
  needs_input: 0,
  failed: 0,
  attention: 0,
  running: 1,
  done: 2,
};

function TaskToastIcon({
  provider,
  bucket,
}: {
  provider: string;
  bucket: WorkspaceStateBucket;
}): ReactElement {
  if (bucket === "running") {
    return (
      <View style={styles.iconWrapper}>
        <SyncedLoader size={ICON_SIZE - 1} color={styles.loader.color} />
      </View>
    );
  }

  const Icon = getProviderIcon(provider);
  const dotStyle = DOT_STYLE_BY_BUCKET[bucket];

  return (
    <View style={styles.iconWrapper}>
      <Icon size={ICON_SIZE} color={styles.icon.color} />
      {dotStyle ? <View style={dotStyle} /> : null}
    </View>
  );
}

// The set of agent keys whose conversation is actually on screen right now: the
// focused tab of every pane in the active workspace. A finished task's toast is
// only dismissed once its agent is genuinely displayed (not merely clicked), so
// the pile stays a reliable "go check these" list until you've opened each one.
function useOnScreenAgentKeys(): ReadonlySet<string> {
  const selection = useActiveWorkspaceSelection();
  const serverId = selection?.serverId ?? null;
  const persistenceKey = selection
    ? buildWorkspaceTabPersistenceKey({
        serverId: selection.serverId,
        workspaceId: selection.workspaceId,
      })
    : null;
  const layout = useWorkspaceLayoutStore((state) =>
    persistenceKey ? (state.layoutByWorkspace[persistenceKey] ?? null) : null,
  );

  return useMemo(() => {
    const keys = new Set<string>();
    if (!layout || !serverId) {
      return keys;
    }
    const tabs = collectAllTabs(layout.root);
    for (const pane of collectAllPanes(layout.root)) {
      const focusedTab = tabs.find((tab) => tab.tabId === pane.focusedTabId);
      if (focusedTab?.target.kind === "agent") {
        keys.add(agentTaskToastKey(serverId, focusedTab.target.agentId));
      }
    }
    return keys;
  }, [layout, serverId]);
}

// Shared source of truth for both the desktop toast stack and the mobile
// floating button + drawer: reconciles the toast store against the live agent
// list and returns the sorted, currently-visible tracked tasks.
export function useTrackedTasks(): TrackedTask[] {
  const { agents } = useAggregatedAgents();
  const reconcile = useAgentTaskToastStore((state) => state.reconcile);
  const dismiss = useAgentTaskToastStore((state) => state.dismiss);
  const order = useAgentTaskToastStore((state) => state.order);
  const onScreenKeys = useOnScreenAgentKeys();

  const buckets = useMemo(() => {
    const map = new Map<string, TrackedTask>();
    for (const agent of agents) {
      const key = agentTaskToastKey(agent.serverId, agent.id);
      map.set(key, { key, agent, bucket: bucketOf(agent) });
    }
    return map;
  }, [agents]);

  const activeKeys = useMemo(
    () => [...buckets.values()].filter((task) => task.bucket !== "done").map((task) => task.key),
    [buckets],
  );
  const existingKeys = useMemo(() => new Set(buckets.keys()), [buckets]);

  useEffect(() => {
    reconcile({ activeKeys, existingKeys });
  }, [reconcile, activeKeys, existingKeys]);

  // Auto-sort by lifecycle lane so cards settle into three groups: waiting-for-user
  // at the top, running in the middle, finished at the bottom (nearest the corner).
  // Within a lane, keep appearance order (oldest first) for stability. Any tracked
  // key whose agent has since disappeared is dropped.
  const items = useMemo(() => {
    const list: TrackedTask[] = [];
    for (const key of order.keys()) {
      const task = buckets.get(key);
      if (task) {
        list.push(task);
      }
    }
    list.sort((a, b) => {
      const rankDiff = BUCKET_GROUP_RANK[a.bucket] - BUCKET_GROUP_RANK[b.bucket];
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0);
    });
    return list;
  }, [order, buckets]);

  // Acknowledge a finished task once its agent is actually on screen: opening it
  // (via a toast click or any other route) makes it a pane's focused tab, and only
  // then does its card leave the pile. A finished agent you're already looking at
  // needs no reminder, so it's dropped too.
  useEffect(() => {
    for (const task of items) {
      if (task.bucket === "done" && onScreenKeys.has(task.key)) {
        dismiss(task.key);
      }
    }
  }, [items, onScreenKeys, dismiss]);

  return items;
}

export function TaskToast({
  task,
  onActivate,
  fullWidth = false,
  contentStyle,
}: {
  task: TrackedTask;
  // Fired after navigation so a host (e.g. the mobile drawer) can dismiss itself.
  onActivate?: () => void;
  // When hosted in the mobile drawer the card should span the full width instead
  // of the floating-stack's capped 320px pill.
  fullWidth?: boolean;
  // Depth fade for the collapsed pile. Applied to the *content* (icon + text) only,
  // so the card's surface, border and shadow stay fully opaque while the readable
  // bits recede into the distance. Absent (mobile drawer) = fully opaque content.
  contentStyle?: AnimatedStyle<ViewStyle>;
}): ReactElement {
  const { t } = useTranslation();
  const title = task.agent.title || t("agentList.fallbackTitle");
  const pipColorStyle = PIP_STYLE_BY_BUCKET[task.bucket];
  const isRunning = task.bucket === "running";

  // Re-render once a second while running so the live "running for" counter advances.
  const [elapsedTick, setElapsedTick] = useState(0);
  useEffect(() => {
    if (!isRunning) {
      return;
    }
    const id = setInterval(() => setElapsedTick((tick) => tick + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  // Every toast leads with the project name, then a time read that depends on state:
  // running shows a live "running for Xs" counter; a settled task shows how long the
  // request took plus when it finished. lastUserMessageAt is the server's start-of-
  // request stamp, so the duration is correct even for a task already done on load.
  const subtitle = useMemo(() => {
    // elapsedTick drives the per-second recompute while running.
    void elapsedTick;
    const projectName = task.agent.projectPlacement?.projectName ?? "";
    const startMs = task.agent.lastUserMessageAt?.getTime() ?? null;

    if (isRunning) {
      const runningText =
        startMs !== null
          ? t("agentList.runningFor", { duration: formatDuration(Date.now() - startMs) })
          : "";
      return [projectName, runningText].filter(Boolean).join(" · ") || null;
    }

    const finishedAt = task.agent.attentionTimestamp ?? task.agent.lastActivityAt;
    const finishedMs = finishedAt ? finishedAt.getTime() : null;
    const durationText =
      startMs !== null && finishedMs !== null && finishedMs >= startMs
        ? formatDuration(finishedMs - startMs)
        : "";
    const finishTime = finishedAt ? formatMessageTimestamp(finishedAt) : "";
    return [projectName, durationText, finishTime].filter(Boolean).join(" · ") || null;
  }, [
    isRunning,
    elapsedTick,
    task.agent.projectPlacement,
    task.agent.lastUserMessageAt,
    task.agent.attentionTimestamp,
    task.agent.lastActivityAt,
    t,
  ]);

  // Merge the static row layout with the (animated) depth-fade opacity once, so the
  // JSX doesn't allocate a fresh style array every render.
  const rowStyle = useMemo(() => [styles.contentRow, contentStyle], [contentStyle]);

  const resolveAgentTask = useTaskBoardToastNavStore((state) => state.resolveAgentTask);
  const handlePress = useCallback(() => {
    // Contextual navigation: when the tasks board is on screen it registers a
    // resolver (see TasksScreen). If this toast's agent belongs to one of the
    // board's tasks, it opens that task's drawer — the same as tapping its card.
    // Anywhere else (base interface, or an agent not on the current board), fall
    // back to opening the agent conversation.
    const handled =
      resolveAgentTask?.({ serverId: task.agent.serverId, agentId: task.agent.id }) ?? false;
    if (!handled) {
      navigateToAgent({
        serverId: task.agent.serverId,
        agentId: task.agent.id,
        workspaceId: task.agent.workspaceId,
        pin: false,
      });
    }
    // No dismissal here: opening the agent makes it a pane's focused tab, and the
    // stack drops the finished card only once that agent is genuinely on screen
    // (see useTrackedTasks). A click that never surfaces the agent keeps the card.
    onActivate?.();
  }, [task, onActivate, resolveAgentTask]);

  return (
    <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          style={fullWidth ? taskToastFullWidthPressableStyle : taskToastPressableStyle}
          onPress={handlePress}
          testID={`task-toast-${task.agent.serverId}-${task.agent.id}`}
        >
          {pipColorStyle ? <View style={pipColorStyle} /> : null}
          <Animated.View style={rowStyle}>
            <TaskToastIcon provider={task.agent.provider} bucket={task.bucket} />
            <View style={styles.textColumn}>
              <Text style={styles.title} numberOfLines={1}>
                {title}
              </Text>
              {subtitle ? (
                <Text style={styles.meta} numberOfLines={1}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          </Animated.View>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="left" align="center">
        <Text style={styles.tooltipText}>{title}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

// A small pill anchored below the pile that folds the stack up or unfolds it
// again. The chevrons point together when the stack is open (tap to collapse)
// and apart when it is folded (tap to expand), with the task count alongside.
function CollapseToggle({
  collapsed,
  count,
  onPress,
}: {
  collapsed: boolean;
  count: number;
  onPress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const Icon = collapsed ? ChevronsUpDown : ChevronsDownUp;
  const label = collapsed ? t("agentTasksToast.expand", { count }) : t("agentTasksToast.collapse");
  return (
    <Pressable
      onPress={onPress}
      style={collapseToggleStyle}
      hitSlop={6}
      testID="agent-tasks-toast-collapse"
    >
      <Icon size={13} color={styles.collapseToggleLabel.color} />
      <Text style={styles.collapseToggleLabel}>{label}</Text>
    </Pressable>
  );
}

// A grab handle sitting next to the collapse toggle. Dragging it slides the whole
// pile horizontally (see the Pan gesture in the stack). Pure affordance — it has no
// tap behaviour, just a grab cursor on web and the drag gesture attached by the host.
function DragHandle({ gesture }: { gesture: DraggableToast["gesture"] }): ReactElement {
  const { t } = useTranslation();
  return (
    <GestureDetector gesture={gesture}>
      <View
        style={dragHandleStyle}
        accessibilityLabel={t("agentTasksToast.drag")}
        testID="agent-tasks-toast-drag"
      >
        <GripVertical size={13} color={styles.collapseToggleLabel.color} />
      </View>
    </GestureDetector>
  );
}

// One row in the pile. Reports its natural height back to the stack so the
// collapsed layout can overlap it, and animates the fold offset + z-order.
function ToastStackItem({
  task,
  overlap,
  opacity,
  zIndex,
  onMeasure,
}: {
  task: TrackedTask;
  overlap: number;
  opacity: number;
  zIndex: number;
  onMeasure: (key: string, height: number) => void;
}): ReactElement {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => onMeasure(task.key, event.nativeEvent.layout.height),
    [onMeasure, task.key],
  );

  // Ease the overlap between 0 (unfolded) and its collapsed target so the pile
  // folds and unfolds smoothly instead of snapping.
  const foldOffset = useSharedValue(overlap);
  useEffect(() => {
    foldOffset.value = withTiming(overlap, { duration: FOLD_DURATION_MS });
  }, [overlap, foldOffset]);
  // The depth fade rides the same timing as the fold, so cards dim into the pile
  // as it collapses and brighten back to full as it opens. It only touches the
  // card *content* (icon + text) — the surface stays fully opaque — so the pile
  // reads as solid cards receding, not translucent glass.
  const contentOpacity = useSharedValue(opacity);
  useEffect(() => {
    contentOpacity.value = withTiming(opacity, { duration: FOLD_DURATION_MS });
  }, [opacity, contentOpacity]);
  const contentStyle = useAnimatedStyle(() => ({ opacity: contentOpacity.value }));
  // zIndex rides along in the animated style so later (lower) cards stay on top
  // and the ones behind only show their top sliver — no second style prop needed.
  const wrapperStyle = useAnimatedStyle(() => ({
    marginBottom: foldOffset.value,
    zIndex,
  }));

  return (
    <Animated.View onLayout={handleLayout} style={wrapperStyle} pointerEvents="box-none">
      <TaskToast task={task} contentStyle={contentStyle} />
    </Animated.View>
  );
}

export function AgentTasksToastStack(): ReactElement | null {
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const visible = useTrackedTasks();
  const collapsed = useAgentTaskToastStore((state) => state.collapsed);
  const setCollapsed = useAgentTaskToastStore((state) => state.setCollapsed);
  const section = useToastSection();
  // Natural (unfolded) height of each card, keyed by task, so the collapsed pile
  // can pull each card up over the one behind it and leave only a top sliver.
  const [heights, setHeights] = useState<Record<string, number>>({});
  // Web-only: while the cursor is over the collapsed pile, unfold it so the user
  // can glance at every card without committing a click. No-op on native (the
  // pointer events never fire) and irrelevant when the pile isn't collapsed.
  const [isHovered, setIsHovered] = useState(false);
  const handleHoverEnter = useCallback(() => setIsHovered(true), []);
  const handleHoverLeave = useCallback(() => setIsHovered(false), []);

  const containerStyle = useMemo(
    () => [styles.container, inlineUnistylesStyle({ bottom: BASE_BOTTOM_OFFSET + insets.bottom })],
    [insets.bottom],
  );

  const handleMeasure = useCallback((key: string, height: number) => {
    setHeights((prev) => (prev[key] === height ? prev : { ...prev, [key]: height }));
  }, []);

  // Free drag via the grab handle: the pile rides on a translate we clamp to the
  // viewport, remembered per app section so its spot in chat is independent from
  // its spot in the tasks board.
  const {
    gesture: dragGesture,
    animatedStyle: dragAnimatedStyle,
    onLayout: onDragLayout,
  } = useDraggableToast({
    placement: "stack",
    section,
    rightOffset: RAIL_CLEARANCE,
    bottomOffset: BASE_BOTTOM_OFFSET + insets.bottom,
  });
  const animatedContainerStyle = useMemo(
    () => [containerStyle, dragAnimatedStyle],
    [containerStyle, dragAnimatedStyle],
  );

  const canCollapse = visible.length > 1;
  // `null` = auto: fold once the corner gets busy; an explicit choice always wins.
  const wantsCollapsed = collapsed ?? visible.length >= AUTO_COLLAPSE_COUNT;
  // The sticky (persisted) fold state drives the toggle; hover only relaxes the
  // *visual* fold so peeking at the pile doesn't flip the user's saved choice.
  const stickyCollapsed = wantsCollapsed && canCollapse;
  const isCollapsed = stickyCollapsed && !isHovered;

  const handleToggle = useCallback(
    () => setCollapsed(!stickyCollapsed),
    [setCollapsed, stickyCollapsed],
  );

  if (isCompact || visible.length === 0) {
    return null;
  }

  // The front (fully visible) card is the last one — nearest the bottom-right
  // corner. Cards above it fold up behind it, so their status pips peek out.
  const lastIndex = visible.length - 1;

  return (
    <Animated.View style={animatedContainerStyle} pointerEvents="box-none" onLayout={onDragLayout}>
      <View
        style={styles.hoverWrapper}
        onPointerEnter={handleHoverEnter}
        onPointerLeave={handleHoverLeave}
      >
        {visible.map((task, index) => {
          const isFront = index === lastIndex;
          const overlap =
            isCollapsed && !isFront ? -Math.max((heights[task.key] ?? 0) - COLLAPSED_PEEK, 0) : 0;
          // Depth fade only while piled: front card stays solid, each one behind it
          // dims a step (floored) so the stack recedes into the distance.
          const depthFromFront = lastIndex - index;
          const opacity = isCollapsed
            ? Math.max(1 - depthFromFront * COLLAPSED_OPACITY_STEP, COLLAPSED_MIN_OPACITY)
            : 1;
          return (
            <ToastStackItem
              key={task.key}
              task={task}
              overlap={overlap}
              opacity={opacity}
              zIndex={index}
              onMeasure={handleMeasure}
            />
          );
        })}
        <View style={styles.controlsRow}>
          <DragHandle gesture={dragGesture} />
          {canCollapse ? (
            <CollapseToggle
              collapsed={stickyCollapsed}
              count={visible.length}
              onPress={handleToggle}
            />
          ) : null}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    right: RAIL_CLEARANCE,
    alignItems: "flex-end",
    maxWidth: 320,
    zIndex: 1000,
  },
  // Hover target that hugs the pile + controls. It has to be a plain (pointer-events
  // auto) child of the box-none container so `onPointerEnter`/`Leave` actually fire —
  // a box-none node is transparent to the pointer and never gets them.
  hoverWrapper: {
    alignItems: "flex-end",
    gap: theme.spacing[2],
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    maxWidth: 320,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    ...theme.shadow.md,
  },
  toastFullWidth: {
    alignSelf: "stretch",
    // "100%" (not undefined) so it reliably overrides the base 320px cap when the
    // styles merge — a later `undefined` does not reset an earlier value in RN.
    maxWidth: "100%",
  },
  toastHovered: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
  },
  statusPip: {
    position: "absolute",
    // Straddle the top-left corner: sit half outside the card, overlapping the
    // border, above the toast content.
    top: -5,
    left: -5,
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.full,
    borderWidth: 2,
    borderColor: theme.colors.surface0,
    zIndex: 2,
  },
  statusPipNeedsInput: {
    backgroundColor: theme.colors.palette.amber[500],
  },
  statusPipRunning: {
    backgroundColor: theme.colors.palette.blue[500],
  },
  statusPipFailed: {
    backgroundColor: theme.colors.palette.red[500],
  },
  statusPipDone: {
    backgroundColor: theme.colors.palette.green[500],
  },
  iconWrapper: {
    width: ICON_SIZE,
    height: ICON_SIZE,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  icon: {
    color: theme.colors.foregroundMuted,
  },
  statusDot: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
  },
  statusDotNeedsInput: {
    backgroundColor: theme.colors.palette.amber[500],
  },
  statusDotFailed: {
    backgroundColor: theme.colors.palette.red[500],
  },
  statusDotAttention: {
    backgroundColor: theme.colors.palette.green[500],
  },
  loader: {
    color:
      theme.colorScheme === "light"
        ? theme.colors.palette.amber[700]
        : theme.colors.palette.amber[500],
  },
  // Holds the icon + text row inside the opaque card. Carries the depth-fade
  // opacity (via contentStyle) so the surface/border/shadow stay solid while the
  // readable content dims. Reproduces the row layout the Pressable used to own.
  contentRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  textColumn: {
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  title: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  meta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  // Drag handle + collapse toggle share one right-aligned row below the pile.
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  collapseToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    ...theme.shadow.sm,
  },
  dragHandle: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    ...theme.shadow.sm,
  },
  collapseToggleHovered: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
  },
  collapseToggleLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));

function collapseToggleStyle({
  hovered = false,
  pressed,
}: {
  hovered?: boolean;
  pressed: boolean;
}) {
  return [styles.collapseToggle, (hovered || pressed) && styles.collapseToggleHovered];
}

// Grab cursor on web signals the handle is draggable; native ignores the cast.
const dragHandleStyle = [styles.dragHandle, isWeb && ({ cursor: "grab" } as object)];

// Declared after `styles` so the referenced style identities exist. `done` maps to
// no dot (finished tasks show only the provider icon).
const DOT_STYLE_BY_BUCKET: Record<WorkspaceStateBucket, StyleProp<ViewStyle>> = {
  needs_input: [styles.statusDot, styles.statusDotNeedsInput],
  failed: [styles.statusDot, styles.statusDotFailed],
  attention: [styles.statusDot, styles.statusDotAttention],
  running: null,
  done: null,
};

// A solid colored dot tells states apart at a glance: amber while an agent waits for
// the user, blue while it runs, green once it has finished, red on failure.
const PIP_STYLE_BY_BUCKET: Record<WorkspaceStateBucket, StyleProp<ViewStyle>> = {
  needs_input: [styles.statusPip, styles.statusPipNeedsInput],
  attention: [styles.statusPip, styles.statusPipDone],
  done: [styles.statusPip, styles.statusPipDone],
  running: [styles.statusPip, styles.statusPipRunning],
  failed: [styles.statusPip, styles.statusPipFailed],
};

function taskToastPressableStyle({
  hovered = false,
  pressed,
}: {
  hovered?: boolean;
  pressed: boolean;
}) {
  return [styles.toast, (hovered || pressed) && styles.toastHovered];
}

function taskToastFullWidthPressableStyle({
  hovered = false,
  pressed,
}: {
  hovered?: boolean;
  pressed: boolean;
}) {
  return [styles.toast, styles.toastFullWidth, (hovered || pressed) && styles.toastHovered];
}

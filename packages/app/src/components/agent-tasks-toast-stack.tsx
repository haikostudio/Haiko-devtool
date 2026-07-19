import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  deriveAgentStateBucket,
  type WorkspaceStateBucket,
} from "@getpaseo/protocol/agent-state-bucket";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { getProviderIcon } from "@/components/provider-icons";
import { SyncedLoader } from "@/components/synced-loader";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { formatDuration, formatMessageTimestamp } from "@/utils/time";
import { agentTaskToastKey, useAgentTaskToastStore } from "@/stores/agent-task-toast-store";

const ICON_SIZE = 16;
// Matches theme.spacing[4]; kept as a literal so the container can add the
// safe-area inset without subscribing the whole component to the theme runtime.
const BASE_BOTTOM_OFFSET = 16;
// The magic scrollbar rail lives at right:12 with a 20px width, so it occupies
// the rightmost ~32px of the pane. Offset the toast stack past it (plus a small
// gap) so the rail stays visible instead of hiding behind the toasts.
const RAIL_CLEARANCE = 44;

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

// Shared source of truth for both the desktop toast stack and the mobile
// floating button + drawer: reconciles the toast store against the live agent
// list and returns the sorted, currently-visible tracked tasks.
export function useTrackedTasks(): TrackedTask[] {
  const { agents } = useAggregatedAgents();
  const reconcile = useAgentTaskToastStore((state) => state.reconcile);
  const order = useAgentTaskToastStore((state) => state.order);

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
  return useMemo(() => {
    const items: TrackedTask[] = [];
    for (const key of order.keys()) {
      const task = buckets.get(key);
      if (task) {
        items.push(task);
      }
    }
    items.sort((a, b) => {
      const rankDiff = BUCKET_GROUP_RANK[a.bucket] - BUCKET_GROUP_RANK[b.bucket];
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0);
    });
    return items;
  }, [order, buckets]);
}

export function TaskToast({
  task,
  onActivate,
  fullWidth = false,
}: {
  task: TrackedTask;
  // Fired after navigation so a host (e.g. the mobile drawer) can dismiss itself.
  onActivate?: () => void;
  // When hosted in the mobile drawer the card should span the full width instead
  // of the floating-stack's capped 320px pill.
  fullWidth?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const dismiss = useAgentTaskToastStore((state) => state.dismiss);
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

  const handlePress = useCallback(() => {
    navigateToAgent({
      serverId: task.agent.serverId,
      agentId: task.agent.id,
      workspaceId: task.agent.workspaceId,
      pin: false,
    });
    // A finished task is acknowledged on click and removed from the stack. A still
    // active one is only opened — it stays visible until it too finishes.
    if (task.bucket === "done") {
      dismiss(task.key);
    }
    onActivate?.();
  }, [dismiss, task, onActivate]);

  return (
    <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          style={fullWidth ? taskToastFullWidthPressableStyle : taskToastPressableStyle}
          onPress={handlePress}
          testID={`task-toast-${task.agent.serverId}-${task.agent.id}`}
        >
          {pipColorStyle ? <View style={pipColorStyle} /> : null}
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
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="left" align="center">
        <Text style={styles.tooltipText}>{title}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

export function AgentTasksToastStack(): ReactElement | null {
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const visible = useTrackedTasks();

  const containerStyle = useMemo(
    () => [styles.container, inlineUnistylesStyle({ bottom: BASE_BOTTOM_OFFSET + insets.bottom })],
    [insets.bottom],
  );

  if (isCompact || visible.length === 0) {
    return null;
  }

  return (
    <View style={containerStyle} pointerEvents="box-none">
      {visible.map((task) => (
        <TaskToast key={task.key} task={task} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: "absolute",
    right: RAIL_CLEARANCE,
    alignItems: "flex-end",
    gap: theme.spacing[2],
    maxWidth: 320,
    zIndex: 1000,
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
  textColumn: {
    flexShrink: 1,
    minWidth: 0,
    gap: 2,
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
}));

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

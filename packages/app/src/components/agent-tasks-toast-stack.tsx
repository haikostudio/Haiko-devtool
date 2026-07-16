import { useCallback, useEffect, useMemo, type ReactElement } from "react";
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
import { agentTaskToastKey, useAgentTaskToastStore } from "@/stores/agent-task-toast-store";

const ICON_SIZE = 16;
// Matches theme.spacing[4]; kept as a literal so the container can add the
// safe-area inset without subscribing the whole component to the theme runtime.
const BASE_BOTTOM_OFFSET = 16;

interface TrackedTask {
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

function TaskToast({ task }: { task: TrackedTask }): ReactElement {
  const { t } = useTranslation();
  const dismiss = useAgentTaskToastStore((state) => state.dismiss);
  const title = task.agent.title || t("agentList.fallbackTitle");

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
  }, [dismiss, task]);

  return (
    <Tooltip delayDuration={400} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Pressable
          style={taskToastPressableStyle}
          onPress={handlePress}
          testID={`task-toast-${task.agent.serverId}-${task.agent.id}`}
        >
          <TaskToastIcon provider={task.agent.provider} bucket={task.bucket} />
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
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
    if (isCompact) {
      return;
    }
    reconcile({ activeKeys, existingKeys });
  }, [reconcile, activeKeys, existingKeys, isCompact]);

  // Show tracked toasts in appearance order (oldest first → newest sits at the
  // bottom, nearest the corner), dropping any whose agent has since disappeared.
  const visible = useMemo(() => {
    const items: TrackedTask[] = [];
    for (const key of order.keys()) {
      const task = buckets.get(key);
      if (task) {
        items.push(task);
      }
    }
    items.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
    return items;
  }, [order, buckets]);

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
    right: theme.spacing[4],
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
  toastHovered: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
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
  title: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
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

function taskToastPressableStyle({
  hovered = false,
  pressed,
}: {
  hovered?: boolean;
  pressed: boolean;
}) {
  return [styles.toast, (hovered || pressed) && styles.toastHovered];
}

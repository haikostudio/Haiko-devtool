import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { ChevronLeft, GripHorizontal, PanelRight, Wand2, X } from "lucide-react-native";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import type { KanbanTask } from "@/data/tasks";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { TaskAgentChat } from "@/components/tasks/task-agent-chat";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
} from "@/screens/workspace/workspace-pane-content";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedWand = withUnistyles(Wand2);
const ThemedX = withUnistyles(X);
const ThemedGrip = withUnistyles(GripHorizontal);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedPanelRight = withUnistyles(PanelRight);

const MIN_HEIGHT = 220;
const MAX_HEIGHT = 720;
// Comfortable fixed width on desktop; full-width on compact.
const DESKTOP_WIDTH = 560;
const SCREEN_MARGIN = 16;

function clampHeight(height: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height));
}

// RN's ViewStyle `cursor` only types auto|pointer; the row/move cursors are
// web-valid, so apply them as a web-only escape hatch outside stricter typing.
const rowResizeCursor: ViewStyle | undefined = isWeb
  ? ({ cursor: "row-resize" } as unknown as ViewStyle)
  : undefined;
const moveCursor: ViewStyle | undefined = isWeb
  ? ({ cursor: "move" } as unknown as ViewStyle)
  : undefined;

type EnsureState =
  | { status: "loading" }
  | { status: "ready"; agentId: string; workspaceId: string | null }
  | { status: "error"; message: string };

export interface ConductorPanelProps {
  serverId: string | null;
  projectId: string | null;
  /**
   * When set, the dock shows this task's agent chat instead of the persistent
   * conductor agent. `null` = conductor mode.
   */
  dockTask: KanbanTask | null;
  /** Reset the dock back to the conductor agent (clears the task chat). */
  onBackToConductor: () => void;
  /** Open the Details+Billing drawer for the given task. */
  onOpenDetails: (taskId: string) => void;
  /** Launch an agent for a task that has none yet (empty-state button). */
  onRunNow: (taskId: string) => void;
  onClose: () => void;
}

/**
 * Bottom-docked, resizable + horizontally-draggable chat dock. Shows the
 * persistent per-project "Chef d'orchestre" agent by default, and swaps to the
 * selected task's agent chat when a task is tapped on the board. On mount (in
 * conductor mode) it ensures the conductor exists on the host and embeds its live
 * agent via the same WorkspacePaneContent the workspace screen uses; in task mode
 * it embeds the task's primary agent. Switching agents fully remounts the pane
 * (React `key`) so no scroll/terminal state leaks across agents.
 */
export function ConductorPanel({
  serverId,
  projectId,
  dockTask,
  onBackToConductor,
  onOpenDetails,
  onRunNow,
  onClose,
}: ConductorPanelProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();

  const conductorHeight = useTasksBoardUiStore((state) => state.conductorHeight);
  const conductorOffsetX = useTasksBoardUiStore((state) => state.conductorOffsetX);

  const [ensure, setEnsure] = useState<EnsureState>({ status: "loading" });
  const inTaskMode = dockTask !== null;

  const dockTaskId = dockTask?.id ?? null;
  const handleOpenDetailsPress = useCallback(() => {
    if (dockTaskId) {
      onOpenDetails(dockTaskId);
    }
  }, [dockTaskId, onOpenDetails]);

  useEffect(() => {
    // Task chat reads the task's own linked agent — skip the conductor ensure so
    // opening a task never spins up the conductor agent unnecessarily.
    if (inTaskMode) {
      return;
    }
    if (!serverId || !projectId) {
      setEnsure({ status: "error", message: t("tasks.conductor.noProject") });
      return;
    }
    let cancelled = false;
    setEnsure({ status: "loading" });
    const run = async () => {
      const client = getHostRuntimeStore().getClient(serverId);
      if (!client) {
        if (!cancelled) {
          setEnsure({ status: "error", message: t("tasks.conductor.noHost") });
        }
        return;
      }
      try {
        const payload = await client.tasksConductorEnsure(projectId);
        if (cancelled) {
          return;
        }
        if (payload.error || !payload.agentId) {
          setEnsure({
            status: "error",
            message: payload.error ?? t("tasks.conductor.failed"),
          });
          return;
        }
        setEnsure({
          status: "ready",
          agentId: payload.agentId,
          workspaceId: payload.workspaceId ?? null,
        });
      } catch (error) {
        if (!cancelled) {
          setEnsure({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [serverId, projectId, t, inTaskMode]);

  const width = isCompact ? screenWidth : Math.min(DESKTOP_WIDTH, screenWidth - SCREEN_MARGIN * 2);

  // Clamp the horizontal offset so the panel always stays fully on-screen.
  const maxOffset = Math.max(0, (screenWidth - width) / 2 - SCREEN_MARGIN);
  const clampedOffsetX = isCompact
    ? 0
    : Math.min(maxOffset, Math.max(-maxOffset, conductorOffsetX));

  // On a phone, cap the height so the dock never taller than the viewport.
  const maxCompactHeight = screenHeight - insets.top - 24;
  const height = isCompact
    ? Math.min(clampHeight(conductorHeight), maxCompactHeight)
    : clampHeight(conductorHeight);

  const panelStyle = useMemo(
    () => [
      styles.panel,
      {
        width,
        height,
        transform: [{ translateX: clampedOffsetX }],
      },
    ],
    [width, height, clampedOffsetX],
  );

  const dockRootStyle = useMemo(
    () => [styles.dockRoot, isCompact ? { paddingBottom: 0 } : null],
    [isCompact],
  );

  const renderBody = () => {
    if (inTaskMode && dockTask) {
      return (
        <TaskAgentChat
          key={`task:${dockTask.id}:${dockTask.links.primaryAgentId ?? "none"}`}
          serverId={serverId}
          task={dockTask}
          onRunNow={onRunNow}
        />
      );
    }
    if (ensure.status === "loading") {
      return (
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
      );
    }
    if (ensure.status === "error") {
      return (
        <View style={styles.centered}>
          <Text style={styles.errorText}>{ensure.message}</Text>
        </View>
      );
    }
    if (!serverId) {
      return null;
    }
    return (
      <EmbeddedConductorPane
        key={`conductor:${ensure.agentId}`}
        serverId={serverId}
        agentId={ensure.agentId}
        workspaceId={ensure.workspaceId}
      />
    );
  };

  return (
    <View style={dockRootStyle} pointerEvents="box-none">
      <View style={panelStyle} testID="conductor-panel">
        <HeightResizeHandle />
        <View style={styles.header}>
          {inTaskMode && dockTask ? (
            <>
              <Pressable
                onPress={onBackToConductor}
                accessibilityRole="button"
                accessibilityLabel={t("tasks.conductor.backToConductor")}
                style={styles.headerButton}
                testID="conductor-panel-back"
              >
                <ThemedChevronLeft size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
              </Pressable>
              <Text style={styles.title} numberOfLines={1}>
                {dockTask.title}
              </Text>
              <Pressable
                onPress={handleOpenDetailsPress}
                accessibilityRole="button"
                accessibilityLabel={t("tasks.conductor.openDetails")}
                style={styles.detailsButton}
                testID="conductor-panel-open-details"
              >
                <ThemedPanelRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
                <Text style={styles.detailsButtonLabel} numberOfLines={1}>
                  {t("tasks.conductor.openDetails")}
                </Text>
              </Pressable>
            </>
          ) : (
            <>
              <ThemedWand size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
              <Text style={styles.title} numberOfLines={1}>
                {t("tasks.conductor.title")}
              </Text>
            </>
          )}
          {isCompact ? null : <HorizontalDragHandle />}
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t("common.actions.close")}
            style={styles.headerButton}
            testID="conductor-panel-close"
          >
            <ThemedX size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          </Pressable>
        </View>
        <View style={styles.body}>{renderBody()}</View>
      </View>
    </View>
  );
}

// Top-edge horizontal bar that resizes the panel HEIGHT. Uses gesture-handler's
// Pan (which tracks the pointer globally) so the drag survives the cursor leaving
// the handle — the RN responder system used to drop the drag there. `runOnJS`
// keeps the callbacks on the JS thread so they can read/write the Zustand store.
function HeightResizeHandle() {
  const setConductorHeight = useTasksBoardUiStore((state) => state.setConductorHeight);
  const startRef = useRef(0);
  const handleStyle = useMemo(() => [styles.resizeHandle, rowResizeCursor], []);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .hitSlop({ top: 8, bottom: 8 })
        .onStart(() => {
          startRef.current = useTasksBoardUiStore.getState().conductorHeight;
        })
        .onUpdate((event) => {
          // Top handle: dragging up (negative translationY) grows the panel.
          setConductorHeight(clampHeight(startRef.current - event.translationY));
        }),
    [setConductorHeight],
  );
  return (
    <GestureDetector gesture={gesture}>
      <View style={handleStyle} accessibilityRole="adjustable">
        <View style={styles.resizeHandleLine} />
      </View>
    </GestureDetector>
  );
}

// Header grip that moves the panel HORIZONTALLY (desktop only). Same gesture-
// handler approach so the move keeps tracking once the cursor leaves the grip.
function HorizontalDragHandle() {
  const { t } = useTranslation();
  const setConductorOffsetX = useTasksBoardUiStore((state) => state.setConductorOffsetX);
  const startRef = useRef(0);
  const handleStyle = useMemo(() => [styles.dragHandle, moveCursor], []);
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .onStart(() => {
          startRef.current = useTasksBoardUiStore.getState().conductorOffsetX;
        })
        .onUpdate((event) => {
          setConductorOffsetX(startRef.current + event.translationX);
        }),
    [setConductorOffsetX],
  );
  return (
    <GestureDetector gesture={gesture}>
      <View
        style={handleStyle}
        accessibilityRole="adjustable"
        accessibilityLabel={t("tasks.conductor.move")}
      >
        <ThemedGrip size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      </View>
    </GestureDetector>
  );
}

function EmbeddedConductorPane({
  serverId,
  agentId,
  workspaceId,
}: {
  serverId: string;
  agentId: string;
  workspaceId: string | null;
}) {
  const content = useMemo(() => {
    const openInNativeWorkspace = () => {
      if (workspaceId) {
        navigateToAgent({ serverId, agentId, workspaceId });
      }
    };
    return buildWorkspacePaneContentModel({
      tab: {
        key: `tasks:conductor:${agentId}`,
        tabId: `tasks:conductor:${agentId}`,
        kind: "agent",
        target: { kind: "agent", agentId },
      },
      normalizedServerId: serverId,
      normalizedWorkspaceId: workspaceId ?? "",
      onOpenTab: openInNativeWorkspace,
      onCloseCurrentTab: openInNativeWorkspace,
      onRetargetCurrentTab: openInNativeWorkspace,
      onOpenWorkspaceFile: openInNativeWorkspace,
      onOpenImportSheet: openInNativeWorkspace,
    });
  }, [serverId, agentId, workspaceId]);

  return (
    <View style={styles.paneHost}>
      <WorkspacePaneContent content={content} isWorkspaceFocused isPaneFocused />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Bottom-centered dock container that lets taps pass through to the board
  // everywhere except the panel itself.
  dockRoot: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    paddingBottom: theme.spacing[3],
  },
  panel: {
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  resizeHandle: {
    height: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  resizeHandleLine: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  dragHandle: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  headerButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  detailsButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  detailsButtonLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  body: {
    flex: 1,
  },
  paneHost: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  errorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

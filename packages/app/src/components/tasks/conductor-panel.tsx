import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  type GestureResponderEvent,
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { GripHorizontal, Wand2, X } from "lucide-react-native";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
} from "@/screens/workspace/workspace-pane-content";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedWand = withUnistyles(Wand2);
const ThemedX = withUnistyles(X);
const ThemedGrip = withUnistyles(GripHorizontal);

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

const alwaysCapture = () => true;

type EnsureState =
  | { status: "loading" }
  | { status: "ready"; agentId: string; workspaceId: string | null }
  | { status: "error"; message: string };

export interface ConductorPanelProps {
  serverId: string | null;
  projectId: string | null;
  onClose: () => void;
}

/**
 * Bottom-docked, resizable + horizontally-draggable panel that mirrors the
 * persistent per-project "Chef d'orchestre" agent. On mount it ensures the
 * conductor exists on the host (creating it if needed) and then embeds its live
 * agent chat via the same WorkspacePaneContent the workspace screen uses.
 */
export function ConductorPanel({ serverId, projectId, onClose }: ConductorPanelProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const { width: screenWidth } = useWindowDimensions();

  const conductorHeight = useTasksBoardUiStore((state) => state.conductorHeight);
  const setConductorHeight = useTasksBoardUiStore((state) => state.setConductorHeight);
  const conductorOffsetX = useTasksBoardUiStore((state) => state.conductorOffsetX);
  const setConductorOffsetX = useTasksBoardUiStore((state) => state.setConductorOffsetX);

  const [ensure, setEnsure] = useState<EnsureState>({ status: "loading" });

  useEffect(() => {
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
  }, [serverId, projectId, t]);

  const width = isCompact
    ? screenWidth - SCREEN_MARGIN * 2
    : Math.min(DESKTOP_WIDTH, screenWidth - SCREEN_MARGIN * 2);

  // Clamp the horizontal offset so the panel always stays fully on-screen.
  const maxOffset = Math.max(0, (screenWidth - width) / 2 - SCREEN_MARGIN);
  const clampedOffsetX = isCompact
    ? 0
    : Math.min(maxOffset, Math.max(-maxOffset, conductorOffsetX));

  const handleResizeHeight = useCallback(
    (deltaY: number) => {
      // Top handle: dragging up (negative deltaY) grows the panel.
      const current = useTasksBoardUiStore.getState().conductorHeight;
      setConductorHeight(clampHeight(current - deltaY));
    },
    [setConductorHeight],
  );

  const handleDragX = useCallback(
    (deltaX: number) => {
      if (isCompact) {
        return;
      }
      const current = useTasksBoardUiStore.getState().conductorOffsetX;
      setConductorOffsetX(current + deltaX);
    },
    [isCompact, setConductorOffsetX],
  );

  const panelStyle = useMemo(
    () => [
      styles.panel,
      {
        width,
        height: clampHeight(conductorHeight),
        transform: [{ translateX: clampedOffsetX }],
      },
    ],
    [width, conductorHeight, clampedOffsetX],
  );

  const renderBody = () => {
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
        serverId={serverId}
        agentId={ensure.agentId}
        workspaceId={ensure.workspaceId}
      />
    );
  };

  return (
    <View style={styles.dockRoot} pointerEvents="box-none">
      <View style={panelStyle} testID="conductor-panel">
        <HeightResizeHandle onResize={handleResizeHeight} />
        <View style={styles.header}>
          <ThemedWand size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          <Text style={styles.title} numberOfLines={1}>
            {t("tasks.conductor.title")}
          </Text>
          {isCompact ? null : <HorizontalDragHandle onDrag={handleDragX} />}
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

// Top-edge horizontal bar that resizes the panel HEIGHT (RN responder system so
// it works on web without touching DOM APIs). Reports incremental pageY deltas.
function HeightResizeHandle({ onResize }: { onResize: (deltaY: number) => void }) {
  const lastYRef = useRef(0);
  const handleStyle = useMemo(() => [styles.resizeHandle, rowResizeCursor], []);
  const handleGrant = useCallback((event: GestureResponderEvent) => {
    lastYRef.current = event.nativeEvent.pageY;
  }, []);
  const handleMove = useCallback(
    (event: GestureResponderEvent) => {
      const y = event.nativeEvent.pageY;
      onResize(y - lastYRef.current);
      lastYRef.current = y;
    },
    [onResize],
  );
  return (
    <View
      style={handleStyle}
      accessibilityRole="adjustable"
      onStartShouldSetResponder={alwaysCapture}
      onMoveShouldSetResponder={alwaysCapture}
      onResponderGrant={handleGrant}
      onResponderMove={handleMove}
    >
      <View style={styles.resizeHandleLine} />
    </View>
  );
}

// Header grip that moves the panel HORIZONTALLY. Reports incremental pageX
// deltas; the panel clamps the offset so it stays on-screen.
function HorizontalDragHandle({ onDrag }: { onDrag: (deltaX: number) => void }) {
  const { t } = useTranslation();
  const lastXRef = useRef(0);
  const handleStyle = useMemo(() => [styles.dragHandle, moveCursor], []);
  const handleGrant = useCallback((event: GestureResponderEvent) => {
    lastXRef.current = event.nativeEvent.pageX;
  }, []);
  const handleMove = useCallback(
    (event: GestureResponderEvent) => {
      const x = event.nativeEvent.pageX;
      onDrag(x - lastXRef.current);
      lastXRef.current = x;
    },
    [onDrag],
  );
  return (
    <View
      style={handleStyle}
      accessibilityRole="adjustable"
      accessibilityLabel={t("tasks.conductor.move")}
      onStartShouldSetResponder={alwaysCapture}
      onMoveShouldSetResponder={alwaysCapture}
      onResponderGrant={handleGrant}
      onResponderMove={handleMove}
    >
      <ThemedGrip size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
    </View>
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

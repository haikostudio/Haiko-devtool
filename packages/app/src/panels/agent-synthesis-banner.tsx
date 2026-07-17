import { memo, useCallback, useEffect, useState } from "react";
import { type LayoutChangeEvent, Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { useSessionStore } from "@/stores/session-store";

/**
 * Minimalist floating block pinned to the top of an agent conversation. It gives
 * an at-a-glance read of what the agent is currently working on: a title, a
 * two-line synthesis, and (when expanded) the objective and current state.
 *
 * The content is regenerated server-side after each turn (see the daemon's
 * agent-synthesis-generator). When no synthesis exists yet, nothing renders.
 */
export const AgentSynthesisBanner = memo(function AgentSynthesisBanner({
  serverId,
  agentId,
  onHeightChange,
}: {
  serverId: string;
  agentId: string;
  /**
   * Reports the banner's occupied vertical extent (its bottom edge relative to
   * the panel top) so the transcript can inset its content and keep the first
   * message from hiding behind this floating card. Reports 0 when hidden.
   */
  onHeightChange?: (extent: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((prev) => !prev), []);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { y, height } = event.nativeEvent.layout;
      onHeightChange?.(Math.round(y + height));
    },
    [onHeightChange],
  );

  const synthesis = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.synthesis ?? null;
  });
  const title = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.title ?? null;
  });

  const hasSynthesis = Boolean(synthesis);
  useEffect(() => {
    if (!hasSynthesis) {
      onHeightChange?.(0);
    }
  }, [hasSynthesis, onHeightChange]);

  if (!synthesis) {
    return null;
  }

  const hasDetails = Boolean(synthesis.objective || synthesis.state);

  return (
    <View style={styles.host} pointerEvents="box-none" onLayout={handleLayout}>
      <Pressable
        style={styles.card}
        onPress={hasDetails ? toggleExpanded : undefined}
        accessibilityRole={hasDetails ? "button" : undefined}
      >
        <View style={styles.headerRow}>
          <View style={styles.dot} />
          {title ? (
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          ) : null}
          {hasDetails ? (
            <Ionicons
              name={expanded ? "chevron-up" : "chevron-down"}
              size={14}
              style={styles.chevron}
            />
          ) : null}
        </View>

        <Text style={styles.summary} numberOfLines={expanded ? undefined : 2}>
          {synthesis.summary}
        </Text>

        {expanded && hasDetails ? (
          <View style={styles.details}>
            {synthesis.objective ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Objectif</Text>
                <Text style={styles.detailValue}>{synthesis.objective}</Text>
              </View>
            ) : null}
            {synthesis.state ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>État</Text>
                <Text style={styles.detailValue}>{synthesis.state}</Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  host: {
    position: "absolute",
    top: theme.spacing[2],
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 30,
  },
  card: {
    maxWidth: 560,
    width: "94%",
    backgroundColor: theme.colors.surface1,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
    // Subtle lift so it reads as floating above the transcript.
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.primary,
  },
  title: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  chevron: {
    color: theme.colors.foregroundMuted,
  },
  summary: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.35,
    color: theme.colors.foregroundMuted,
  },
  details: {
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  detailRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  detailLabel: {
    width: 58,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
  },
  detailValue: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));

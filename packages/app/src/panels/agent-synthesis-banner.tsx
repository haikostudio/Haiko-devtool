import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { type LayoutChangeEvent, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Ionicons } from "@expo/vector-icons";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import { formatTimeAgo } from "@/utils/time";

/**
 * Minimalist floating block pinned to the top of an agent conversation. It gives
 * an at-a-glance read of what the agent is currently working on: a title, a
 * two-line synthesis, and (when expanded) the objective, the current state, and
 * a scrollable thread of the previous syntheses ("fil conducteur") with the
 * latest always on top.
 *
 * The content is rebuilt server-side (deterministically, no LLM) on each prompt
 * and after each turn — see the daemon's agent-synthesis-builder — so it stays
 * fresh across the whole discussion and updates on every interaction. When no
 * synthesis exists yet, nothing renders. The card spans the same content column
 * as the transcript (see MAX_CONTENT_WIDTH).
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
  const history = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.synthesisHistory ?? null;
  });
  const title = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.title ?? null;
  });

  // Previous entries shown under the current one. The settled thread's head can
  // duplicate the live synthesis (same updatedAt) once a turn has landed — drop
  // it so the top card isn't repeated in the list.
  const previous = useMemo(() => {
    if (!history || history.length === 0) {
      return [];
    }
    if (synthesis && history[0]?.updatedAt === synthesis.updatedAt) {
      return history.slice(1);
    }
    return history;
  }, [history, synthesis]);

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
  const hasThread = previous.length > 0;
  const hasSummary = Boolean(synthesis.summary);
  const expandable = hasSummary || hasDetails || hasThread;

  return (
    <View style={styles.host} pointerEvents="box-none" onLayout={handleLayout}>
      <View style={styles.card}>
        <Pressable
          onPress={expandable ? toggleExpanded : undefined}
          accessibilityRole={expandable ? "button" : undefined}
        >
          <View style={styles.headerRow}>
            <View style={styles.dot} />
            {(synthesis.headline ?? title) ? (
              // Bold header: prefer the generated one-sentence headline (longer,
              // reflects what the turn addressed); fall back to the short tab
              // title on old daemons that don't emit a headline yet.
              <Text style={styles.title} numberOfLines={2}>
                {synthesis.headline ?? title}
              </Text>
            ) : null}
            {expandable ? (
              <Ionicons
                name={expanded ? "chevron-up" : "chevron-down"}
                size={14}
                style={styles.chevron}
              />
            ) : null}
          </View>

          {expanded && hasSummary ? <Text style={styles.summary}>{synthesis.summary}</Text> : null}

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

        {expanded && hasThread ? (
          <View style={styles.thread}>
            <Text style={styles.threadLabel}>Fil des synthèses</Text>
            <ScrollView
              style={styles.threadScroll}
              contentContainerStyle={styles.threadContent}
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              {previous.map((entry) => (
                <View key={`${entry.updatedAt}::${entry.summary}`} style={styles.threadItem}>
                  <Text style={styles.threadTime}>{formatEntryTime(entry.updatedAt)}</Text>
                  <Text style={styles.threadSummary} numberOfLines={3}>
                    {entry.summary}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
        ) : null}
      </View>
    </View>
  );
});

function formatEntryTime(updatedAt: string): string {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return formatTimeAgo(date);
}

const styles = StyleSheet.create((theme) => ({
  host: {
    position: "absolute",
    top: theme.spacing[2],
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    zIndex: 30,
  },
  card: {
    // Match the transcript's content column so the banner reads as part of the
    // conversation rather than a narrow floating pill.
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
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
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
    paddingTop: theme.spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  detailRow: {
    gap: theme.spacing[1],
  },
  detailLabel: {
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 0.5,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    opacity: 0.7,
  },
  detailValue: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.3,
    color: theme.colors.foreground,
  },
  thread: {
    marginTop: theme.spacing[2],
    paddingTop: theme.spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  threadLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
  },
  threadScroll: {
    maxHeight: 220,
  },
  threadContent: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  threadItem: {
    gap: theme.spacing[1],
  },
  threadTime: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    opacity: 0.7,
  },
  threadSummary: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.3,
    color: theme.colors.foregroundMuted,
  },
}));

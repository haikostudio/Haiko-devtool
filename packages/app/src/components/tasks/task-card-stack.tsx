import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { ChevronDown, ChevronRight, Layers } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { KanbanTask } from "@/data/tasks";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedLayers = withUnistyles(Layers);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

// Peeking sheet edges under the lead card. Two is enough to read as "a pile";
// more just eats vertical space, which is the whole point of stacking.
const MAX_PEEKING_SHEETS = 2;

/**
 * Session-scoped expand/collapse state for the batch stacks of one column.
 * Collapsed is the default — a lot is a lot until the user opens it.
 */
export function useBatchExpansion() {
  const [expandedKeys, setExpandedKeys] = useState<Record<string, boolean>>({});
  const isExpanded = useCallback((key: string) => expandedKeys[key] === true, [expandedKeys]);
  const toggleExpanded = useCallback((key: string) => {
    setExpandedKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);
  return { isExpanded, toggleExpanded };
}

/** How a board should render one card of the lot when the pile overrides it. */
export interface RenderCardOptions {
  /** Folded pile: pressing the lead card unfolds the lot instead of opening the task. */
  onPress?: (task: KanbanTask) => void;
  /** Screen-reader label matching that overridden press. */
  accessibilityLabel?: string;
}

interface TaskCardStackProps {
  batchKey: string;
  tasks: KanbanTask[];
  expanded: boolean;
  onToggle: (batchKey: string) => void;
  /** Each board injects its own card row (drag wrapper + overflow menu). */
  renderCard: (task: KanbanTask, options?: RenderCardOptions) => React.ReactNode;
}

function headerStyle({ pressed }: { pressed: boolean }) {
  return [styles.header, pressed && styles.headerPressed];
}

function pileStyle({ pressed }: { pressed: boolean }) {
  return [styles.pile, pressed && styles.pilePressed];
}

/**
 * A lot of cards rendered as one compact pile.
 *
 * Folded, the pile is one single target: header strip, lead card and the
 * peeking sheet edges all unfold it — pressing a folded pile never opens a
 * task, because the card you see is only the cover of the pile. Unfolded, every
 * card gets its normal press back (opening the task) and the header folds it
 * again. Collapsed, only the lead card is mounted, so the column stays short.
 */
export const TaskCardStack = memo(function TaskCardStack({
  batchKey,
  tasks,
  expanded,
  onToggle,
  renderCard,
}: TaskCardStackProps) {
  const { t } = useTranslation();
  const handleToggle = useCallback(() => onToggle(batchKey), [onToggle, batchKey]);
  const toggleLabel = t(expanded ? "tasks.board.batch.collapse" : "tasks.board.batch.expand");
  const toggleState = useMemo(() => ({ expanded }), [expanded]);
  const peekingSheets = Math.min(tasks.length - 1, MAX_PEEKING_SHEETS);
  // Folded: the lead card borrows the header's press. The board keeps rendering
  // it (drag wrapper, overflow menu, voyant) — only the tap target changes.
  const leadCardOptions = useMemo(
    () => ({ onPress: handleToggle, accessibilityLabel: toggleLabel }),
    [handleToggle, toggleLabel],
  );

  return (
    <View style={styles.stack} testID={`tasks-batch-${batchKey}`}>
      <Pressable
        onPress={handleToggle}
        style={headerStyle}
        accessibilityRole="button"
        accessibilityState={toggleState}
        accessibilityLabel={toggleLabel}
        testID={`tasks-batch-toggle-${batchKey}`}
      >
        <ThemedLayers size={ICON_SIZE.xs} uniProps={mutedColorMapping} />
        <Text style={styles.headerLabel}>
          {t("tasks.board.batch.label", { count: tasks.length })}
        </Text>
        <View style={styles.headerSpacer} />
        {expanded ? (
          <ThemedChevronDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        ) : (
          <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        )}
      </Pressable>
      {expanded ? (
        <Animated.View entering={FadeIn.duration(120)} style={styles.expandedList}>
          {tasks.map((task) => (
            <View key={task.id}>{renderCard(task)}</View>
          ))}
        </Animated.View>
      ) : (
        <View>
          {renderCard(tasks[0], leadCardOptions)}
          {/* The pile's own hit area: pressing the sheet edges unfolds the lot,
              exactly like the header and the lead card above them. */}
          <Pressable
            onPress={handleToggle}
            style={pileStyle}
            accessibilityRole="button"
            accessibilityState={toggleState}
            accessibilityLabel={toggleLabel}
          >
            {Array.from({ length: peekingSheets }, (_unused, depth) => (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: purely decorative sheet edges
                key={depth}
                style={depth === 0 ? styles.sheet : [styles.sheet, styles.sheetDeep]}
              />
            ))}
          </Pressable>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  stack: {
    gap: theme.spacing[1],
  },
  // Small strip above the pile — the one deliberate "fold/unfold" target.
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  headerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  headerLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  headerSpacer: {
    flex: 1,
  },
  // Unfolded: the lot's cards keep their normal look, indented behind a rail so
  // it stays obvious they belong together.
  expandedList: {
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
  },
  pile: {
    alignItems: "center",
    paddingTop: 2,
    gap: 2,
  },
  // Sheet edges peeking from under the lead card, each one narrower — the
  // classic stack-of-paper cue, measurement-free.
  sheet: {
    height: 5,
    width: "94%",
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    borderBottomLeftRadius: theme.borderRadius.lg,
    borderBottomRightRadius: theme.borderRadius.lg,
  },
  sheetDeep: {
    width: "88%",
    height: 4,
    opacity: 0.7,
  },
  pilePressed: {
    opacity: 0.7,
  },
}));

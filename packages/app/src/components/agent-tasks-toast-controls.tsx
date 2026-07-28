// The clear controls shared by the desktop pile and the mobile drawer: the
// "what would this clear" counts, the per-category menu, and the short-lived undo
// pill. Both hosts drive the same store actions through `useToastClearActions`,
// so the rules can't drift between them.

import { useCallback, useEffect, useMemo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { CheckCircle2, CircleAlert, CircleHelp, MoreVertical, Undo2 } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AUTO_DISMISS_FINISHED_MS,
  countToastsByCategory,
  selectAutoDismissibleKeys,
  selectFinishedToastKeys,
  selectToastKeysForCategory,
  TOAST_CLEAR_CATEGORIES,
  TOAST_UNDO_WINDOW_MS,
  type ClearableToast,
  type ToastClearCategory,
} from "@/components/agent-tasks-toast-dismissal";
import { useAgentTaskToastStore } from "@/stores/agent-task-toast-store";
import { isWeb } from "@/constants/platform";

// How often the pile checks whether a finished card has sat there long enough to
// tidy itself away. Coarse on purpose: the sweep is housekeeping, not a stopwatch.
const AUTO_DISMISS_TICK_MS = 30_000;

const MENU_ICON_SIZE = 14;

export interface ToastClearActions {
  /** How many cards each category would clear right now. */
  counts: Record<ToastClearCategory, number>;
  /** Cards the plain trash click would clear (the finished ones). */
  finishedCount: number;
  clearFinished: () => void;
  clearCategory: (category: ToastClearCategory) => void;
  /** True while the last clear can still be taken back. */
  canUndo: boolean;
  undoCount: number;
  undo: () => void;
}

/**
 * Everything the trash button and its menu need. Also owns the two timers: the
 * one that retires the undo offer, and the one that sweeps finished cards away
 * once they've lingered long enough.
 */
export function useToastClearActions(tasks: readonly ClearableToast[]): ToastClearActions {
  const dismissMany = useAgentTaskToastStore((state) => state.dismissMany);
  const undoDismissal = useAgentTaskToastStore((state) => state.undoDismissal);
  const clearDismissalUndo = useAgentTaskToastStore((state) => state.clearDismissalUndo);
  const lastDismissal = useAgentTaskToastStore((state) => state.lastDismissal);

  const counts = useMemo(() => countToastsByCategory(tasks), [tasks]);

  const clearCategory = useCallback(
    (category: ToastClearCategory) => {
      dismissMany(selectToastKeysForCategory(tasks, category));
    },
    [dismissMany, tasks],
  );
  const clearFinished = useCallback(() => {
    dismissMany(selectFinishedToastKeys(tasks));
  }, [dismissMany, tasks]);

  // The undo offer is deliberately short: it's a safety net for the click you
  // just regretted, not a second inbox.
  const undoAt = lastDismissal?.at ?? null;
  useEffect(() => {
    if (undoAt === null) {
      return;
    }
    const remaining = Math.max(TOAST_UNDO_WINDOW_MS - (Date.now() - undoAt), 0);
    const timer = setTimeout(clearDismissalUndo, remaining);
    return () => clearTimeout(timer);
  }, [undoAt, clearDismissalUndo]);

  // Housekeeping sweep: finished cards that have sat in the pile past the
  // lingering delay drop off on their own. Reads the clocks straight from the
  // store so the two hosts (pile + drawer) can both run it harmlessly — whoever
  // fires first empties the list and the other finds nothing to do.
  useEffect(() => {
    const sweep = () => {
      const state = useAgentTaskToastStore.getState();
      // Never sweep while an undo is still on offer: a housekeeping batch would
      // overwrite the snapshot and the user's "Undo" would put back the wrong
      // cards. The sweep simply waits for the next tick.
      if (state.lastDismissal !== null) {
        return;
      }
      const due = selectAutoDismissibleKeys(
        state.finishedSince,
        Date.now(),
        AUTO_DISMISS_FINISHED_MS,
      );
      if (due.length > 0) {
        state.dismissMany(due);
      }
    };
    const timer = setInterval(sweep, AUTO_DISMISS_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const undo = useCallback(() => undoDismissal(), [undoDismissal]);

  return {
    counts,
    finishedCount: counts.finished,
    clearFinished,
    clearCategory,
    canUndo: lastDismissal !== null,
    undoCount: lastDismissal?.entries.length ?? 0,
    undo,
  };
}

const CATEGORY_ICONS: Record<ToastClearCategory, typeof CheckCircle2> = {
  finished: CheckCircle2,
  failed: CircleAlert,
  needsInput: CircleHelp,
};

const CATEGORY_LABEL_KEYS: Record<ToastClearCategory, string> = {
  finished: "agentTasksToast.clearFinishedCategory",
  failed: "agentTasksToast.clearFailedCategory",
  needsInput: "agentTasksToast.clearNeedsInputCategory",
};

/**
 * The "⋮" next to the trash: clears one category at a time (finished, failed,
 * waiting) so a read error can go without touching anything else. Running tasks
 * are never listed — they are not clearable by any route.
 */
export function ToastClearMenu({
  counts,
  onClear,
  compact = false,
}: {
  counts: Record<ToastClearCategory, number>;
  onClear: (category: ToastClearCategory) => void;
  /** Drawer header variant: a slightly larger, round tap target. */
  compact?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={compact ? drawerMenuTriggerStyle : menuTriggerStyle}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={t("agentTasksToast.clearMenu")}
        testID="agent-tasks-toast-clear-menu"
      >
        <MoreVertical size={compact ? 16 : 13} color={styles.controlLabel.color} />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end">
        {TOAST_CLEAR_CATEGORIES.map((category) => (
          <ToastClearMenuItem
            key={category}
            category={category}
            count={counts[category]}
            onClear={onClear}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ToastClearMenuItem({
  category,
  count,
  onClear,
}: {
  category: ToastClearCategory;
  count: number;
  onClear: (category: ToastClearCategory) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onClear(category), [onClear, category]);
  const leading = useMemo(() => {
    const Icon = CATEGORY_ICONS[category];
    return <Icon size={MENU_ICON_SIZE} color={styles.controlLabel.color} />;
  }, [category]);
  return (
    <DropdownMenuItem
      onSelect={handleSelect}
      disabled={count === 0}
      leading={leading}
      testID={`agent-tasks-toast-clear-${category}`}
    >
      {t(CATEGORY_LABEL_KEYS[category], { count })}
    </DropdownMenuItem>
  );
}

/**
 * "3 effacées — Annuler", shown for a few seconds after any clear (including the
 * automatic sweep, so cards never disappear without a way back).
 */
export function ToastUndoPill({
  count,
  onUndo,
  stretch = false,
}: {
  count: number;
  onUndo: () => void;
  /** Drawer variant: spans the sheet width instead of hugging the pile edge. */
  stretch?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={stretch ? styles.undoRowStretch : styles.undoRow} testID="agent-tasks-toast-undo">
      <Text style={styles.undoLabel} numberOfLines={1}>
        {t("agentTasksToast.cleared", { count })}
      </Text>
      <Pressable
        onPress={onUndo}
        style={undoButtonStyle}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={t("agentTasksToast.undo")}
        testID="agent-tasks-toast-undo-button"
      >
        <Undo2 size={12} color={styles.undoAction.color} />
        <Text style={styles.undoAction}>{t("agentTasksToast.undo")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // Matches the pile's other icon controls (see agent-tasks-toast-stack).
  menuTrigger: {
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
  menuTriggerHovered: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
  },
  // Drawer header variant: same round 30px target as the trash beside it.
  drawerMenuTrigger: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.full,
  },
  drawerMenuTriggerPressed: {
    backgroundColor: theme.colors.surface2,
  },
  controlLabel: {
    color: theme.colors.foregroundMuted,
  },
  undoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    ...theme.shadow.sm,
  },
  undoRowStretch: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    alignSelf: "stretch",
    marginBottom: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  undoLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  undoButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  undoAction: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  undoButtonPressed: {
    opacity: 0.7,
  },
}));

function menuTriggerStyle({ hovered = false, pressed }: { hovered?: boolean; pressed: boolean }) {
  return [
    styles.menuTrigger,
    isWeb && ({ cursor: "pointer" } as object),
    (hovered || pressed) && styles.menuTriggerHovered,
  ];
}

function drawerMenuTriggerStyle({ pressed }: { pressed: boolean }) {
  return [styles.drawerMenuTrigger, pressed && styles.drawerMenuTriggerPressed];
}

function undoButtonStyle({ hovered = false, pressed }: { hovered?: boolean; pressed: boolean }) {
  return [
    styles.undoButton,
    isWeb && ({ cursor: "pointer" } as object),
    (hovered || pressed) && styles.undoButtonPressed,
  ];
}

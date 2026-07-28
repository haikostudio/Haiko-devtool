import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bell } from "lucide-react-native";
import type { PushHistoryEntry } from "@getpaseo/protocol/messages";

import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  countUnreadNotifications,
  formatUnreadBadge,
  toNotificationRowModel,
  type NotificationRowModel,
} from "@/components/notifications/notification-history-model";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePushHistory } from "@/hooks/use-push-history";
import { useNotificationsReadStore } from "@/stores/notifications-read-store";
import type { Theme } from "@/styles/theme";

const ThemedBell = withUnistyles(Bell);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const EMPTY_LABEL = "Aucune notification pour l'instant";
const PANEL_TITLE = "Notifications";
const BUTTON_LABEL = "Historique des notifications";

// Anchored panel geometry: wide enough for a task title plus a three-sentence
// recap without turning into a second screen, and capped so a long history
// scrolls instead of running off the viewport.
const POPOVER_WIDTH = 360;
const POPOVER_MAX_HEIGHT = 460;
const SUMMARY_MAX_LINES = 3;

const dateTimeFormatter = new Intl.DateTimeFormat("fr-CH", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatSentAt(sentAt: number): string {
  if (!Number.isFinite(sentAt) || sentAt <= 0) {
    return "";
  }
  return dateTimeFormatter.format(new Date(sentAt));
}

/**
 * One notification row — the task, the project it belongs to, when it ran, and
 * a short recap of what happened.
 */
function NotificationRow({ model, isFirst }: { model: NotificationRowModel; isFirst: boolean }) {
  const sentAt = formatSentAt(model.sentAt);
  const meta = [model.projectName, sentAt].filter((part): part is string => Boolean(part));
  return (
    <View style={isFirst ? styles.row : styles.rowDivided}>
      {model.taskTitle.length > 0 ? (
        <Text style={styles.rowTitle} numberOfLines={2}>
          {model.taskTitle}
        </Text>
      ) : null}
      {meta.length > 0 ? (
        <Text style={styles.rowMeta} numberOfLines={1}>
          {meta.join(" · ")}
        </Text>
      ) : null}
      {model.summary ? (
        <Text style={styles.rowBody} numberOfLines={SUMMARY_MAX_LINES}>
          {model.summary}
        </Text>
      ) : null}
    </View>
  );
}

/** Shared body for both presentations — the anchored panel and the sheet. */
function NotificationListBody({
  entries,
  isLoading,
}: {
  entries: PushHistoryEntry[] | null;
  isLoading: boolean;
}) {
  const models = useMemo(() => (entries ?? []).map(toNotificationRowModel), [entries]);
  const isEmpty = !isLoading && models.length === 0;
  return (
    <View style={styles.body}>
      {isLoading && models.length === 0 ? <Text style={styles.hint}>Chargement…</Text> : null}
      {isEmpty ? <Text style={styles.hint}>{EMPTY_LABEL}</Text> : null}
      {models.map((model, index) => (
        <NotificationRow key={model.id} model={model} isFirst={index === 0} />
      ))}
    </View>
  );
}

/** The count pill on the bell. Nothing is drawn when nothing is new. */
function UnreadBadge({ count }: { count: number }) {
  if (count <= 0) {
    return null;
  }
  return (
    <View style={styles.badge} pointerEvents="none" testID="notification-history-badge">
      <Text style={styles.badgeText} numberOfLines={1}>
        {formatUnreadBadge(count)}
      </Text>
    </View>
  );
}

/**
 * "Notifications" — the header bell. It carries a pill counting what arrived
 * since the panel was last opened, and opens the history newest-first: an
 * anchored panel under the bell on a roomy header, the bottom sheet on a phone
 * where a 360px popover would cover the screen anyway.
 *
 * Self-gates on the `pushHistory` daemon capability: renders nothing when no
 * connected host supports it, so the header simply omits the bell on old
 * daemons.
 */
export function NotificationHistoryButton() {
  const isCompact = useIsCompactFormFactor();
  const [open, setOpen] = useState(false);

  // Entries load in the background too — the badge has to be right before
  // anything is opened.
  const { entries, isLoading, isSupported, refresh } = usePushHistory();

  const lastOpenedAt = useNotificationsReadStore((state) => state.lastOpenedAt);
  const hasHydrated = useNotificationsReadStore((state) => state.hasHydrated);
  const markOpened = useNotificationsReadStore((state) => state.markOpened);
  const seedIfUnset = useNotificationsReadStore((state) => state.seedIfUnset);

  // First run: anchor "new" to now instead of announcing the whole backlog.
  useEffect(() => {
    if (hasHydrated) {
      seedIfUnset(Date.now());
    }
  }, [hasHydrated, seedIfUnset]);

  const unreadCount = useMemo(
    () => (hasHydrated ? countUnreadNotifications(entries, lastOpenedAt) : 0),
    [entries, hasHydrated, lastOpenedAt],
  );

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) {
        // Opening is the read event: the badge drops to zero and the list is
        // re-fetched so the newest arrivals are already there.
        markOpened(Date.now());
        refresh();
      }
    },
    [markOpened, refresh],
  );

  const handleOpen = useCallback(() => handleOpenChange(true), [handleOpenChange]);
  const handleClose = useCallback(() => handleOpenChange(false), [handleOpenChange]);

  const header = useMemo<SheetHeader>(() => ({ title: PANEL_TITLE }), []);

  if (!isSupported) {
    return null;
  }

  if (isCompact) {
    return (
      <>
        <Pressable
          testID="notification-history-button"
          onPress={handleOpen}
          accessibilityRole="button"
          accessibilityLabel={BUTTON_LABEL}
          style={styles.button}
        >
          <ThemedBell size={20} uniProps={iconColorMapping} />
          <UnreadBadge count={unreadCount} />
        </Pressable>
        <AdaptiveModalSheet
          visible={open}
          onClose={handleClose}
          header={header}
          scrollable
          testID="notification-history-modal"
        >
          <NotificationListBody entries={entries} isLoading={isLoading} />
        </AdaptiveModalSheet>
      </>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        testID="notification-history-button"
        accessibilityRole="button"
        accessibilityLabel={BUTTON_LABEL}
        style={triggerStyle}
      >
        <ThemedBell size={20} uniProps={iconColorMapping} />
        <UnreadBadge count={unreadCount} />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="bottom"
        width={POPOVER_WIDTH}
        maxHeight={POPOVER_MAX_HEIGHT}
        scrollable
        testID="notification-history-popover"
      >
        {/* The dropdown surface carries no inner padding — rows normally bring
            their own — so the panel supplies it once, here. */}
        <View style={styles.popoverPadding}>
          <Text style={styles.panelTitle}>{PANEL_TITLE}</Text>
          <NotificationListBody entries={entries} isLoading={isLoading} />
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function triggerStyle({ pressed, hovered }: { pressed: boolean; hovered: boolean }) {
  return [styles.button, (hovered || pressed) && styles.buttonHovered];
}

const styles = StyleSheet.create((theme) => ({
  button: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  buttonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  badge: {
    position: "absolute",
    top: 2,
    right: 0,
    minWidth: 16,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.destructive,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.destructiveForeground,
  },
  panelTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
    paddingBottom: theme.spacing[2],
  },
  popoverPadding: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  body: {
    paddingBottom: theme.spacing[1],
  },
  row: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  // Rows are dense prose blocks; a hairline is what keeps two consecutive
  // recaps from reading as one paragraph.
  rowDivided: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.borderAccent,
  },
  rowTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  rowBody: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  rowMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  hint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));

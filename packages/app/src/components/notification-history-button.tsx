import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bell } from "lucide-react-native";
import type { PushHistoryEntry } from "@getpaseo/protocol/messages";

import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { usePushHistory } from "@/hooks/use-push-history";
import type { Theme } from "@/styles/theme";

const ThemedBell = withUnistyles(Bell);
const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const EMPTY_LABEL = "Aucune notification pour l'instant";

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

/** One notification row — title, message, then the date and time it was sent. */
function NotificationRow({ entry }: { entry: PushHistoryEntry }) {
  const sentAt = formatSentAt(entry.sentAt);
  return (
    <View style={styles.row}>
      {entry.title.length > 0 ? (
        <Text style={styles.rowTitle} numberOfLines={2}>
          {entry.title}
        </Text>
      ) : null}
      {entry.body.length > 0 ? <Text style={styles.rowBody}>{entry.body}</Text> : null}
      {sentAt.length > 0 ? <Text style={styles.rowMeta}>{sentAt}</Text> : null}
    </View>
  );
}

/**
 * "Notifications" — a bell icon for the mobile header that opens a drawer listing
 * every push notification the daemon has dispatched, newest first. Self-gates on
 * the `pushHistory` daemon capability: renders nothing when no connected host
 * supports it, so the header simply omits the bell on old daemons.
 */
export function NotificationHistoryButton() {
  const [open, setOpen] = useState(false);
  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);

  // Only fetch while the drawer is open; isSupported is derived from advertised
  // host features regardless of the enabled flag.
  const { entries, isLoading, isSupported } = usePushHistory(open);

  const header = useMemo<SheetHeader>(() => ({ title: "Notifications" }), []);

  const total = entries?.length ?? 0;
  const isEmpty = !isLoading && total === 0;

  if (!isSupported) {
    return null;
  }

  return (
    <>
      <Pressable
        testID="notification-history-button"
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel="Historique des notifications"
        style={styles.button}
      >
        <ThemedBell size={20} uniProps={iconColorMapping} />
      </Pressable>
      <AdaptiveModalSheet
        visible={open}
        onClose={handleClose}
        header={header}
        testID="notification-history-modal"
      >
        <View style={styles.body}>
          {isLoading && total === 0 ? <Text style={styles.hint}>Chargement…</Text> : null}
          {isEmpty ? <Text style={styles.hint}>{EMPTY_LABEL}</Text> : null}
          {(entries ?? []).map((entry) => (
            <NotificationRow key={entry.id} entry={entry} />
          ))}
        </View>
      </AdaptiveModalSheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  row: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
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

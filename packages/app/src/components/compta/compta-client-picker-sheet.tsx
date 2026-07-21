import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, CircleOff, UserRound } from "lucide-react-native";
import type { ComptaClient } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { LIST_ROW_HEIGHT } from "@/components/ui/control-geometry";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";

const ThemedUser = withUnistyles(UserRound);
const ThemedNone = withUnistyles(CircleOff);
const ThemedCheck = withUnistyles(Check);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const NONE_ICON = <ThemedNone size={ICON_SIZE.md} uniProps={mutedColorMapping} />;
const USER_ICON = <ThemedUser size={ICON_SIZE.md} uniProps={mutedColorMapping} />;

/**
 * Billing-client picker sheet, shared by the project configuration entry points
 * and the task "Facturation" tab. Lists the accounting instance's clients (via
 * the daemon proxy) with the current selection checked; `allowNone` adds a
 * "not billed" row that clears the selection.
 */
export function ComptaClientPickerSheet({
  visible,
  onClose,
  serverId,
  selectedClientId,
  allowNone,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  serverId: string;
  selectedClientId: string | null;
  allowNone?: boolean;
  onSelect: (client: ComptaClient | null) => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const [clients, setClients] = useState<ComptaClient[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!visible || !client) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const fetched = await client.listComptaClients();
        if (!cancelled) {
          setClients(fetched);
        }
      } catch {
        if (!cancelled) {
          setClients([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, client]);

  const handlePick = useCallback(
    (picked: ComptaClient | null) => {
      onSelect(picked);
      onClose();
    },
    [onSelect, onClose],
  );

  const header = useMemo(() => ({ title: t("settings.project.billing.client") }), [t]);

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      dynamicSizing
      testID="compta-client-picker"
    >
      <View style={styles.container}>
        {allowNone ? (
          <ClientRow
            icon={NONE_ICON}
            label={t("settings.project.billing.none")}
            selected={selectedClientId === null}
            value={null}
            onPick={handlePick}
          />
        ) : null}
        {loading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator />
          </View>
        ) : null}
        {!loading && clients.length === 0 ? (
          <Text style={styles.emptyText}>{t("settings.project.billing.noClients")}</Text>
        ) : null}
        {clients.map((entry) => (
          <ClientRow
            key={entry.id}
            icon={USER_ICON}
            label={entry.name}
            description={entry.company}
            selected={entry.id === selectedClientId}
            value={entry}
            onPick={handlePick}
          />
        ))}
      </View>
    </AdaptiveModalSheet>
  );
}

function ClientRow({
  icon,
  label,
  description,
  selected,
  value,
  onPick,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  selected: boolean;
  value: ComptaClient | null;
  onPick: (client: ComptaClient | null) => void;
}) {
  const handlePress = useCallback(() => onPick(value), [onPick, value]);
  return (
    <Pressable onPress={handlePress} accessibilityRole="button" style={styles.row}>
      {icon}
      <View style={styles.rowBody}>
        <Text style={styles.rowLabel} numberOfLines={1}>
          {label}
        </Text>
        {description ? (
          <Text style={styles.rowDescription} numberOfLines={1}>
            {description}
          </Text>
        ) : null}
      </View>
      {selected ? <ThemedCheck size={ICON_SIZE.sm} uniProps={accentColorMapping} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: LIST_ROW_HEIGHT,
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  rowBody: {
    flex: 1,
    gap: theme.spacing[1],
  },
  rowLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  rowDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  loadingRow: {
    paddingVertical: theme.spacing[3],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
  },
}));

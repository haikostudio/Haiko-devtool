import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Receipt } from "lucide-react-native";
import type { KanbanTask } from "@/data/tasks";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";
import {
  BILLABLE_HOURLY_RATE_CHF,
  computeBillableCostChf,
  formatChf,
} from "@/components/tasks/task-cost";

const ThemedReceipt = withUnistyles(Receipt);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * "Facturation" tab of the task drawer: presents the task as the billable line
 * it would become on an invoice — label (task title), estimated time, hourly
 * rate and the resulting amount. Read-only on purpose: it never touches the
 * billing app. Creating or editing an invoice always goes through an explicit
 * agent request (the compta skill), never a tap here.
 */
export function TaskBillingView({ task }: { task: KanbanTask }) {
  const { t } = useTranslation();
  const minutes = task.estimate?.estimatedMinutes;
  const hasBilling = minutes !== undefined && minutes > 0;

  if (!hasBilling) {
    return (
      <View style={styles.emptyState}>
        <ThemedReceipt size={ICON_SIZE.lg} uniProps={mutedColorMapping} />
        <Text style={styles.emptyText}>{t("tasks.panel.billingLine.noEstimate")}</Text>
      </View>
    );
  }

  const amount = computeBillableCostChf(minutes);
  const rateValue = `${BILLABLE_HOURLY_RATE_CHF} CHF/h`;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t("tasks.panel.billingLine.title")}</Text>
        <Row label={t("tasks.panel.billingLine.label")} value={task.title} />
        <Row label={t("tasks.panel.billingLine.time")} value={formatDuration(minutes)} />
        <Row label={t("tasks.panel.billingLine.rate")} value={rateValue} />
        <View style={styles.divider} />
        <Row label={t("tasks.panel.billingLine.amount")} value={formatChf(amount)} emphasized />
      </View>
      <Text style={styles.note}>{t("tasks.panel.billingLine.note")}</Text>
    </ScrollView>
  );
}

function Row({ label, value, emphasized }: { label: string; value: string; emphasized?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={emphasized ? styles.rowValueStrong : styles.rowValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

// Minutes → "Xh Ymin" (drops the hour part below 60, drops minutes when round).
function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rowLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  rowValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    textAlign: "right",
  },
  rowValueStrong: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    flexShrink: 1,
    textAlign: "right",
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[1],
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[1],
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
}));

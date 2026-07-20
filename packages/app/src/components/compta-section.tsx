import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ComptaSummaryRow } from "@getpaseo/protocol/messages";
import { useIsCompactFormFactor } from "@/constants/layout";
import { baseColors } from "@/styles/theme";

interface ComptaSectionProps {
  rows: ComptaSummaryRow[];
}

/**
 * Glanceable billing card for the dashboard: one line per issuing company with
 * invoiced / received / outstanding amounts for the current month. Amounts are
 * computed daemon-side; this component only formats and renders them.
 */
export function ComptaSection({ rows }: ComptaSectionProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();

  // Hide companies with nothing to show — a row full of zeros is noise.
  const activeRows = useMemo(
    () =>
      rows.filter(
        (row) =>
          row.invoicedThisMonth > 0 ||
          row.paidThisMonth > 0 ||
          row.outstanding > 0 ||
          row.draftCount > 0,
      ),
    [rows],
  );

  const cardStyle = useMemo(
    () => (isCompact ? [styles.card, styles.cardCompact] : styles.card),
    [isCompact],
  );
  const containerStyle = useMemo(
    () => (isCompact ? [styles.container, styles.containerCompact] : styles.container),
    [isCompact],
  );

  if (activeRows.length === 0) {
    return null;
  }

  return (
    <View style={containerStyle}>
      <View style={cardStyle}>
        <View style={styles.headerRow}>
          <Text style={styles.title}>{t("dashboard.compta.title")}</Text>
          <Text style={styles.monthLabel}>{t("dashboard.compta.thisMonth")}</Text>
        </View>
        {activeRows.map((row) => (
          <View key={`${row.company}-${row.currency}`} style={styles.companyBlock}>
            <View style={styles.companyHeader}>
              <Text style={styles.companyName} numberOfLines={1}>
                {row.company}
              </Text>
              <Text style={styles.currencyLabel}>{row.currency}</Text>
            </View>
            <View style={styles.metricsRow}>
              <Metric
                label={t("dashboard.compta.invoiced")}
                value={formatAmount(row.invoicedThisMonth)}
              />
              <Metric label={t("dashboard.compta.paid")} value={formatAmount(row.paidThisMonth)} />
              <Metric
                label={t("dashboard.compta.outstanding")}
                value={formatAmount(row.outstanding)}
                highlight={row.outstanding > 0}
                badge={
                  row.overdueCount > 0
                    ? t("dashboard.compta.overdue", { count: row.overdueCount })
                    : undefined
                }
              />
            </View>
            {row.draftCount > 0 ? (
              <Text style={styles.draftLabel}>
                {t("dashboard.compta.drafts", { count: row.draftCount })}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

function Metric({
  label,
  value,
  highlight,
  badge,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  badge?: string;
}) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricValue(highlight === true)} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.metricLabel} numberOfLines={1}>
        {label}
      </Text>
      {badge ? (
        <Text style={styles.overdueBadge} numberOfLines={1}>
          {badge}
        </Text>
      ) : null}
    </View>
  );
}

// Swiss-style thousands separator, decimals only when meaningful: 12'450 / 292.50.
function formatAmount(value: number): string {
  const [int, dec] = value.toFixed(2).split(".");
  const withSeparators = int.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return dec === "00" ? withSeparators : `${withSeparators}.${dec}`;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
  },
  containerCompact: {
    paddingHorizontal: theme.spacing[2],
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  cardCompact: {
    padding: theme.spacing[2],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  monthLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  companyBlock: {
    gap: theme.spacing[2],
  },
  companyHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  companyName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    flexShrink: 1,
  },
  currencyLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  metricsRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  metric: {
    flex: 1,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    alignItems: "center",
    gap: 2,
  },
  metricValue: (highlight: boolean) => ({
    color: highlight ? baseColors.amber[500] : theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  }),
  metricLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
  overdueBadge: {
    color: baseColors.red[500],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  draftLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

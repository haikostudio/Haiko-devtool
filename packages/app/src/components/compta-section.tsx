import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import type {
  ComptaInvoiceRef,
  ComptaMonthlyRevenue,
  ComptaSummaryRow,
} from "@getpaseo/protocol/messages";
import { useIsCompactFormFactor } from "@/constants/layout";
import { baseColors } from "@/styles/theme";

const CHART_HEIGHT = 96;
const INVOICED_COLOR = baseColors.purple[500];
const PAID_COLOR = baseColors.green[500];
const GOAL_COLOR = baseColors.amber[500];

interface ComptaSectionProps {
  rows: ComptaSummaryRow[];
  monthly: ComptaMonthlyRevenue | null;
}

/**
 * Glanceable billing section for the dashboard: one card with per-company
 * invoiced / received / outstanding amounts (tap a company to reveal the
 * invoices behind the numbers), next to a 12-month revenue chart. Amounts are
 * computed daemon-side; this component only formats and renders them.
 */
export function ComptaSection({ rows, monthly }: ComptaSectionProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

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

  const hasChart = useMemo(
    () => monthly !== null && monthly.points.some((point) => point.invoiced > 0 || point.paid > 0),
    [monthly],
  );

  const toggleExpanded = useCallback((key: string) => {
    setExpandedKey((current) => (current === key ? null : key));
  }, []);

  const containerStyle = useMemo(
    () => (isCompact ? [styles.container, styles.containerCompact] : styles.container),
    [isCompact],
  );
  const rowLayoutStyle = useMemo(
    () => (isCompact ? styles.cardsColumn : styles.cardsRow),
    [isCompact],
  );
  const cardStyle = useMemo(
    () => (isCompact ? [styles.card, styles.cardCompact] : styles.card),
    [isCompact],
  );

  if (activeRows.length === 0 && !hasChart) {
    return null;
  }

  return (
    <View style={containerStyle}>
      <View style={rowLayoutStyle}>
        {activeRows.length > 0 ? (
          <View style={cardStyle}>
            <View style={styles.headerRow}>
              <Text style={styles.title}>{t("dashboard.compta.title")}</Text>
              <Text style={styles.monthLabel}>{t("dashboard.compta.thisMonth")}</Text>
            </View>
            {activeRows.map((row) => {
              const key = `${row.company}-${row.currency}`;
              return (
                <CompanyBlock
                  key={key}
                  blockKey={key}
                  row={row}
                  isExpanded={expandedKey === key}
                  onToggle={toggleExpanded}
                />
              );
            })}
          </View>
        ) : null}

        {monthly !== null && hasChart ? (
          <View style={cardStyle}>
            <View style={styles.headerRow}>
              <Text style={styles.title}>{t("dashboard.compta.yearTitle")}</Text>
              <Text style={styles.monthLabel}>{monthly.currency}</Text>
            </View>
            <GoalProgress monthly={monthly} />
            <YearChart monthly={monthly} />
            <View style={styles.legendRow}>
              <View style={styles.legendItem}>
                <View style={styles.legendDot(INVOICED_COLOR)} />
                <Text style={styles.legendLabel}>{t("dashboard.compta.invoiced")}</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={styles.legendDot(PAID_COLOR)} />
                <Text style={styles.legendLabel}>{t("dashboard.compta.paid")}</Text>
              </View>
              {monthly.goal !== undefined && monthly.goal > 0 ? (
                <View style={styles.legendItem}>
                  <View style={styles.legendDash} />
                  <Text style={styles.legendLabel}>{t("dashboard.compta.goalLegend")}</Text>
                </View>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function CompanyBlock({
  blockKey,
  row,
  isExpanded,
  onToggle,
}: {
  blockKey: string;
  row: ComptaSummaryRow;
  isExpanded: boolean;
  onToggle: (key: string) => void;
}) {
  const { t } = useTranslation();
  const invoices = row.invoices ?? [];
  const showDetail = isExpanded && invoices.length > 0;
  const ExpandIcon = showDetail ? ChevronUp : ChevronDown;
  const handleToggle = useCallback(() => {
    onToggle(blockKey);
  }, [onToggle, blockKey]);

  return (
    <View style={styles.companyBlock}>
      <Pressable
        onPress={handleToggle}
        accessibilityRole="button"
        disabled={invoices.length === 0}
        style={styles.companyPressable}
      >
        <View style={styles.companyHeader}>
          <Text style={styles.companyName} numberOfLines={1}>
            {row.company}
          </Text>
          <Text style={styles.currencyLabel}>{row.currency}</Text>
          {invoices.length > 0 ? <ExpandIcon size={14} color={styles.expandIcon.color} /> : null}
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
        {row.draftCount > 0 && !showDetail ? (
          <Text style={styles.draftLabel}>
            {t("dashboard.compta.drafts", { count: row.draftCount })}
          </Text>
        ) : null}
      </Pressable>
      {showDetail ? (
        <View style={styles.invoiceList}>
          {invoices.map((invoice) => (
            <InvoiceLine key={invoice.number} invoice={invoice} />
          ))}
        </View>
      ) : null}
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

function InvoiceLine({ invoice }: { invoice: ComptaInvoiceRef }) {
  const { t } = useTranslation();
  const isOpen = invoice.amountDue > 0 && invoice.status !== "draft";
  const amount = isOpen ? invoice.amountDue : invoice.total;
  const statusLabel = t(`dashboard.compta.status.${invoice.status}`, {
    defaultValue: invoice.status,
  });
  return (
    <View style={styles.invoiceRow}>
      <View style={styles.invoiceMain}>
        <Text style={styles.invoiceTitle} numberOfLines={1}>
          {invoice.number} · {invoice.title || invoice.client}
        </Text>
        <Text style={styles.invoiceSub} numberOfLines={1}>
          {invoice.client}
          {isOpen && invoice.dueDate
            ? ` · ${t("dashboard.compta.due", { date: formatShortDate(invoice.dueDate) })}`
            : ""}
        </Text>
      </View>
      <View style={styles.invoiceRight}>
        <Text style={styles.invoiceAmount} numberOfLines={1}>
          {formatAmount(amount)}
        </Text>
        <Text style={styles.invoiceStatus(invoice.status)} numberOfLines={1}>
          {statusLabel}
        </Text>
      </View>
    </View>
  );
}

// "This month: X / goal (N %)" progress line under the chart title.
function GoalProgress({ monthly }: { monthly: ComptaMonthlyRevenue }) {
  const { t } = useTranslation();
  const goal = monthly.goal;
  if (goal === undefined || goal <= 0) {
    return null;
  }
  const current = monthly.points[monthly.points.length - 1]?.invoiced ?? 0;
  const pct = Math.round((current / goal) * 100);
  return (
    <Text style={styles.goalLine}>
      {t("dashboard.compta.goalLine", {
        current: formatAmount(current),
        goal: formatAmount(goal),
        pct,
      })}
    </Text>
  );
}

function YearChart({ monthly }: { monthly: ComptaMonthlyRevenue }) {
  const goal = monthly.goal !== undefined && monthly.goal > 0 ? monthly.goal : null;
  const maxValue = Math.max(
    1,
    goal ?? 0,
    ...monthly.points.map((point) => Math.max(point.invoiced, point.paid)),
  );
  // Bars sit above an 18px label zone; the goal line offset accounts for it.
  const goalBottom = goal !== null ? 18 + Math.round((goal / maxValue) * CHART_HEIGHT) : null;
  return (
    <View style={styles.chartArea}>
      {goalBottom !== null ? <View style={styles.goalRule(goalBottom)} /> : null}
      {monthly.points.map((point, index) => {
        const invoicedHeight =
          point.invoiced > 0
            ? Math.max(2, Math.round((point.invoiced / maxValue) * CHART_HEIGHT))
            : 0;
        const paidHeight =
          point.paid > 0 ? Math.max(2, Math.round((point.paid / maxValue) * CHART_HEIGHT)) : 0;
        // Always label the current (last) month, then every other going back.
        const showLabel = (monthly.points.length - 1 - index) % 2 === 0;
        return (
          <View key={point.month} style={styles.barColumn}>
            <View style={styles.barTrack}>
              <View style={styles.bar(invoicedHeight, INVOICED_COLOR)} />
              <View style={styles.bar(paidHeight, PAID_COLOR)} />
            </View>
            <Text style={styles.barLabel} numberOfLines={1}>
              {showLabel ? point.month.slice(5) : " "}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

// Swiss-style thousands separator, decimals only when meaningful: 12'450 / 292.50.
function formatAmount(value: number): string {
  const [int, dec] = value.toFixed(2).split(".");
  const withSeparators = int.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return dec === "00" ? withSeparators : `${withSeparators}.${dec}`;
}

// YYYY-MM-DD → DD.MM
function formatShortDate(date: string): string {
  const [, month, day] = date.split("-");
  return `${day}.${month}`;
}

function statusColor(status: string, theme: { colors: { foregroundMuted: string } }): string {
  switch (status) {
    case "overdue":
      return baseColors.red[500];
    case "sent":
    case "partial":
      return baseColors.amber[500];
    case "paid":
      return baseColors.green[500];
    default:
      return theme.colors.foregroundMuted;
  }
}

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
  },
  containerCompact: {
    paddingHorizontal: theme.spacing[2],
  },
  cardsRow: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: theme.spacing[3],
  },
  cardsColumn: {
    flexDirection: "column",
    gap: theme.spacing[3],
  },
  card: {
    flex: 1,
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
  companyPressable: {
    gap: theme.spacing[2],
  },
  companyHeader: {
    flexDirection: "row",
    alignItems: "center",
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
    flexGrow: 1,
  },
  expandIcon: {
    color: theme.colors.foregroundMuted,
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
    gap: theme.spacing[1],
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
  invoiceList: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  invoiceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
  },
  invoiceMain: {
    flex: 1,
    gap: theme.spacing[1],
  },
  invoiceTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  invoiceSub: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  invoiceRight: {
    alignItems: "flex-end",
    gap: theme.spacing[1],
  },
  invoiceAmount: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
  },
  invoiceStatus: (status: string) => ({
    color: statusColor(status, theme),
    fontSize: theme.fontSize.xs,
  }),
  chartArea: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[1],
    height: CHART_HEIGHT + 18,
  },
  goalLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  goalRule: (bottom: number) => ({
    position: "absolute" as const,
    left: 0,
    right: 0,
    bottom,
    borderTopWidth: 1,
    borderStyle: "dashed" as const,
    borderColor: GOAL_COLOR,
  }),
  legendDash: {
    width: 10,
    height: 0,
    borderTopWidth: 1,
    borderStyle: "dashed" as const,
    borderColor: GOAL_COLOR,
  },
  barColumn: {
    flex: 1,
    alignItems: "stretch",
    justifyContent: "flex-end",
    gap: theme.spacing[1],
  },
  barTrack: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "center",
    gap: 1,
    height: CHART_HEIGHT,
  },
  bar: (height: number, color: string) => ({
    width: 5,
    height,
    borderRadius: 2,
    backgroundColor: color,
  }),
  barLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: 9,
    textAlign: "center",
  },
  legendRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  legendDot: (color: string) => ({
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: color,
  }),
  legendLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

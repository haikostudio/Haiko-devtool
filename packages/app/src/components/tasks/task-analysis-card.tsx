import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Sparkles } from "lucide-react-native";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";
import { computeManualBillingChf, formatChf } from "@/components/tasks/task-cost";
import type { TaskAnalysisEstimate } from "@/components/tasks/task-analysis-estimate";

const ThemedSparkles = withUnistyles(Sparkles);
const accentColorMapping = (theme: Theme) => ({ color: theme.colors.accent });

// Compact grouped thousands ("12 000"), locale-independent so the estimate
// reads the same everywhere. Small counts stay as-is.
function formatTokens(tokens: number): string {
  return Math.round(tokens)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// One-decimal hours, trimming a trailing ".0" so "3" stays "3" and "3.5" stays.
function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

interface EstimateRow {
  key: string;
  label: string;
  value: string;
}

/**
 * Renders the task-analysis agent's structured estimate as a readable card: the
 * one-line summary as a paragraph, then the numbers (runtime, quota, tokens,
 * cost, billable hours, confidence) in a clean table. Replaces the raw ```json
 * block the agent appends to its message, so the task chat never shows raw data.
 */
export function TaskAnalysisCard({ estimate }: { estimate: TaskAnalysisEstimate }) {
  const { t } = useTranslation();

  const confidenceLabel = useMemo(() => {
    switch (estimate.confidence) {
      case "high":
        return t("tasks.panel.analysis.confidenceHigh");
      case "medium":
        return t("tasks.panel.analysis.confidenceMedium");
      default:
        return t("tasks.panel.analysis.confidenceLow");
    }
  }, [estimate.confidence, t]);

  const rows = useMemo<EstimateRow[]>(() => {
    const entries: EstimateRow[] = [
      {
        key: "runtime",
        label: t("tasks.panel.analysis.runtime"),
        value: `${estimate.estimatedMinutes} min`,
      },
      {
        key: "quota",
        label: t("tasks.panel.analysis.quota"),
        value: `${Math.round(estimate.quotaPercent)} %`,
      },
      {
        key: "tokens",
        label: t("tasks.panel.analysis.tokens"),
        value: formatTokens(estimate.tokens),
      },
    ];
    if (estimate.billingHours !== undefined) {
      entries.push(
        {
          key: "cost",
          label: t("tasks.panel.analysis.cost"),
          value: formatChf(computeManualBillingChf(estimate.billingHours)),
        },
        {
          key: "hours",
          label: t("tasks.panel.analysis.billableHours"),
          value: `${formatHours(estimate.billingHours)} h`,
        },
      );
    }
    entries.push({
      key: "confidence",
      label: t("tasks.panel.analysis.confidence"),
      value: confidenceLabel,
    });
    return entries;
  }, [confidenceLabel, estimate, t]);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <ThemedSparkles size={ICON_SIZE.sm} uniProps={accentColorMapping} />
        <Text style={styles.title}>{t("tasks.panel.analysis.title")}</Text>
      </View>
      {estimate.summary.trim() ? (
        <Text style={styles.summary}>{estimate.summary.trim()}</Text>
      ) : null}
      <View style={styles.table}>
        {rows.map((row, index) => (
          <View key={row.key} style={index === 0 ? styles.rowFirst : styles.row}>
            <Text style={styles.rowLabel}>{row.label}</Text>
            <Text style={styles.rowValue}>{row.value}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    marginVertical: theme.spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  summary: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  table: {
    marginTop: theme.spacing[1],
  },
  rowFirst: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  rowLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  rowValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
    textAlign: "right",
  },
}));

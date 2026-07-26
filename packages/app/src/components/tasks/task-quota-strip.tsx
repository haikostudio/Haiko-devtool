import { useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import type { ProviderUsageWindow } from "@/provider-usage/types";

// Above this share of the weekly allowance the gauge turns amber, and above the
// second threshold it turns red: the point of the strip is to warn BEFORE the
// week runs dry, not to report it afterwards.
const WEEKLY_WARN_PCT = 75;
const WEEKLY_DANGER_PCT = 90;

// A rolling window is matched on its label because providers name them
// differently ("5-hour", "session", "hebdomadaire"…). Both matchers are
// deliberately loose: a window we fail to classify simply isn't shown, it never
// shows up under the wrong heading.
function isRollingWindow(window: ProviderUsageWindow): boolean {
  const id = `${window.id} ${window.label}`.toLowerCase();
  return /5\s*-?\s*h|five|session|glissant/.test(id);
}

function isWeeklyWindow(window: ProviderUsageWindow): boolean {
  const id = `${window.id} ${window.label}`.toLowerCase();
  return /week|hebdo|7\s*-?\s*(d|j)/.test(id);
}

function usedPercent(window: ProviderUsageWindow | null): number | null {
  if (!window) {
    return null;
  }
  if (typeof window.usedPct === "number") {
    return Math.max(0, Math.min(100, window.usedPct));
  }
  if (typeof window.remainingPct === "number") {
    return Math.max(0, Math.min(100, 100 - window.remainingPct));
  }
  return null;
}

/**
 * The permanent quota line at the top of the timeline area.
 *
 * It is deliberately always on screen — even with nothing scheduled — because it
 * answers the question the board can't: how much room is left to run anything at
 * all. Two gauges: the rolling window the scheduler packs against, and the
 * weekly allowance that actually caps the week.
 */
export function TaskQuotaStrip({ serverId }: { serverId: string | null }) {
  const { t } = useTranslation();
  const { view } = useProviderUsage(serverId);

  const { rolling, weekly } = useMemo(() => {
    if (view.kind !== "ready") {
      return { rolling: null, weekly: null };
    }
    // Prefer the provider that actually reports windows; several may answer.
    const windows = view.payload.providers.flatMap((provider) => provider.windows ?? []);
    return {
      rolling: windows.find(isRollingWindow) ?? null,
      weekly: windows.find(isWeeklyWindow) ?? null,
    };
  }, [view]);

  const rollingPct = usedPercent(rolling);
  const weeklyPct = usedPercent(weekly);
  const weeklyTone = resolveWeeklyTone(weeklyPct);
  const unavailable = view.kind !== "ready" || (rollingPct === null && weeklyPct === null);

  return (
    <View style={styles.strip} testID="tasks-quota-strip">
      <QuotaGauge
        label={rolling?.label ?? t("tasks.quota.rolling")}
        percent={rollingPct}
        tone="neutral"
        unavailableLabel={t("tasks.quota.unavailable")}
      />
      <QuotaGauge
        label={weekly?.label ?? t("tasks.quota.weekly")}
        percent={weeklyPct}
        tone={weeklyTone}
        unavailableLabel={t("tasks.quota.unavailable")}
      />
      {unavailable ? <Text style={styles.hint}>{t("tasks.quota.unavailable")}</Text> : null}
    </View>
  );
}

// Amber past the warning threshold, red past the danger one — the point is to
// warn BEFORE the week runs dry.
function resolveWeeklyTone(percent: number | null): "neutral" | "warn" | "danger" {
  if (percent === null) {
    return "neutral";
  }
  if (percent >= WEEKLY_DANGER_PCT) {
    return "danger";
  }
  if (percent >= WEEKLY_WARN_PCT) {
    return "warn";
  }
  return "neutral";
}

function QuotaGauge({
  label,
  percent,
  tone,
  unavailableLabel,
}: {
  label: string;
  percent: number | null;
  tone: "neutral" | "warn" | "danger";
  unavailableLabel: string;
}) {
  const fillStyle = useMemo(
    () => [
      styles.gaugeFill,
      tone === "warn" && styles.gaugeFillWarn,
      tone === "danger" && styles.gaugeFillDanger,
      { width: `${percent ?? 0}%` as const },
    ],
    [percent, tone],
  );
  return (
    <View style={styles.gauge}>
      <View style={styles.gaugeHeader}>
        <Text style={styles.gaugeLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={tone === "danger" ? styles.gaugeValueDanger : styles.gaugeValue}>
          {percent === null ? unavailableLabel : `${Math.round(percent)} %`}
        </Text>
      </View>
      <View style={styles.gaugeTrack}>
        <View style={fillStyle} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // One row, two gauges sharing the width. Short enough that the timeline can be
  // dragged right down to it and the quotas still read.
  strip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  gauge: {
    flex: 1,
    gap: theme.spacing[1],
  },
  gaugeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  gaugeLabel: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  gaugeValue: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontVariant: ["tabular-nums"],
  },
  gaugeValueDanger: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.xs,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  gaugeTrack: {
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  gaugeFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.blue[500],
  },
  gaugeFillWarn: {
    backgroundColor: theme.colors.palette.amber[500],
  },
  gaugeFillDanger: {
    backgroundColor: theme.colors.palette.red[500],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

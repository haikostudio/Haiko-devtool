import { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import Svg, { Circle, Polyline } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import { useProviderUsageHistory } from "@/provider-usage/use-provider-usage-history";
import type { ProviderUsageWindow } from "@/provider-usage/types";
import { useQuotaAlertStore } from "@/stores/quota-alert-store";
import type { Theme } from "@/styles/theme";
import {
  forecastDay,
  forecastRunOut,
  sparklinePoints,
  toSamples,
  type QuotaSample,
} from "./task-quota-history";
import {
  buildQuotaSummary,
  REMAINING_DANGER_PCT,
  remainingPercent,
  resetCountdown,
  toneForRemaining,
  type QuotaProviderSummary,
  type QuotaTone,
} from "./task-quota-summary";

const RING_SIZE = 20;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CENTER = RING_SIZE / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

// Svg primitives take colors as plain props, so they go through withUnistyles
// rather than a style sheet (see docs/unistyles.md).
const ThemedCircle = withUnistyles(Circle);
const ThemedPolyline = withUnistyles(Polyline);

const SPARKLINE_SIZE = { width: 240, height: 26 };
const NO_SAMPLES: QuotaSample[] = [];

// The track has to be readable on its own: when the host reports no number it is
// the ONLY thing drawn, and a surface-on-surface circle simply cannot be seen.
const trackColorMapping = (theme: Theme) => ({ stroke: theme.colors.border });
const sparklineColorMapping = (theme: Theme) => ({ stroke: theme.colors.foregroundMuted });

function ringColorMapping(tone: QuotaTone) {
  return (theme: Theme) => ({ stroke: toneColor(theme, tone) });
}

function toneColor(theme: Theme, tone: QuotaTone): string {
  switch (tone) {
    case "danger":
      return theme.colors.destructive;
    case "warn":
      return theme.colors.palette.amber[500];
    default:
      return theme.colors.foreground;
  }
}

/**
 * The header's quota ring: a circular gauge of the WEEKLY allowance still left,
 * across every connected model — the week runs out as soon as the first one does.
 *
 * Tapping it opens the per-model breakdown, both windows each: the short rolling
 * session and the weekly allowance. It replaces the old permanent quota strip
 * that ate a full row above the timeline for the same two numbers.
 */
export function TaskQuotaMenuButton({ serverId }: { serverId: string | null }) {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const [open, setOpen] = useState(false);
  const { view, refresh, canFetch } = useProviderUsage(serverId);
  const { series } = useProviderUsageHistory(serverId);

  const summary = useMemo(
    () => buildQuotaSummary(view.kind === "ready" ? view.payload : null),
    [view],
  );

  // The low-quota warning lives here rather than in the menu so it keeps firing
  // while the menu is closed — a warning you only see after opening it is useless.
  useEffect(() => {
    const alerts = useQuotaAlertStore.getState();
    for (const provider of summary.providers) {
      const remaining = remainingPercent(provider.weekly);
      if (remaining === null) continue;

      if (remaining > REMAINING_DANGER_PCT) {
        alerts.clearWarned(provider.providerId);
        continue;
      }
      const resetKey = provider.weekly?.resetsAt ?? "current";
      if (!alerts.shouldWarn(provider.providerId, resetKey)) continue;
      alerts.markWarned(provider.providerId, resetKey);
      toast.show(
        t("tasks.quota.lowAlert", {
          provider: provider.displayName,
          percent: Math.round(remaining),
        }),
        { variant: "warning", durationMs: 6000 },
      );
    }
  }, [summary, t, toast]);

  // The host traces both windows; the curve shows the weekly one, the number
  // that decides whether the week holds.
  const weeklySamplesByProvider = useMemo(() => {
    const byProvider = new Map<string, QuotaSample[]>();
    for (const entry of series) {
      if (entry.kind !== "weekly") continue;
      byProvider.set(entry.providerId, toSamples(entry.samples));
    }
    return byProvider;
  }, [series]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      // Quotas move while the board is open; re-ask on every reveal rather than
      // showing whatever the 5-minute cache still holds.
      if (nextOpen) {
        void refresh().catch(() => {});
      }
    },
    [refresh],
  );

  // No host capability, no ring: the gauge would have nothing to show and the
  // feature is gated in one place (see the capability rules in CLAUDE.md).
  if (!canFetch) {
    return null;
  }

  const remaining = summary.ringRemainingPct;
  const tone = toneForRemaining(remaining);

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger
        style={triggerStyle}
        accessibilityRole="button"
        accessibilityLabel={t("tasks.quota.buttonLabel")}
        testID="tasks-quota-menu-trigger"
      >
        <QuotaRing percent={remaining} tone={tone} />
        {/* A bare ring is invisible against a dark header — especially with no
            number to draw, which is exactly when it matters that the control can
            still be found. The label always shows on a roomy header, and falls
            back to a dash when the host reports nothing. */}
        {isCompact ? null : (
          <Text style={tone === "danger" ? styles.triggerValueDanger : styles.triggerValue}>
            {remaining === null
              ? t("tasks.quota.noData")
              : t("tasks.quota.percentShort", { percent: Math.round(remaining) })}
          </Text>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" width={280} testID="tasks-quota-menu">
        <View style={styles.menu}>
          <Text style={styles.menuTitle}>{t("tasks.quota.title")}</Text>
          {view.kind === "loading" ? <Text style={styles.hint}>{t("common.loading")}</Text> : null}
          {summary.providers.length === 0 && view.kind !== "loading" ? (
            <Text style={styles.hint}>{t("tasks.quota.unavailable")}</Text>
          ) : null}
          {summary.providers.map((provider) => (
            <QuotaProviderBlock
              key={provider.providerId}
              provider={provider}
              samples={weeklySamplesByProvider.get(provider.providerId) ?? NO_SAMPLES}
            />
          ))}
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function triggerStyle({ pressed, hovered }: { pressed: boolean; hovered: boolean }) {
  return [styles.trigger, (hovered || pressed) && styles.triggerHovered];
}

/** Circular gauge whose arc is what is LEFT, not what is spent. */
function QuotaRing({ percent, tone }: { percent: number | null; tone: QuotaTone }) {
  const dashOffset = RING_CIRCUMFERENCE - ((percent ?? 0) / 100) * RING_CIRCUMFERENCE;
  return (
    <Svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      style={styles.ring}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <ThemedCircle
        cx={RING_CENTER}
        cy={RING_CENTER}
        r={RING_RADIUS}
        fill="none"
        strokeWidth={RING_STROKE}
        uniProps={trackColorMapping}
      />
      {percent === null ? null : (
        <ThemedCircle
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={RING_RADIUS}
          fill="none"
          strokeWidth={RING_STROKE}
          strokeLinecap="round"
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          uniProps={ringColorMapping(tone)}
        />
      )}
    </Svg>
  );
}

function QuotaProviderBlock({
  provider,
  samples,
}: {
  provider: QuotaProviderSummary;
  samples: QuotaSample[];
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.provider}>
      <View style={styles.providerHeader}>
        <Text style={styles.providerName} numberOfLines={1}>
          {provider.displayName}
        </Text>
        {provider.planLabel ? (
          <Text style={styles.providerPlan} numberOfLines={1}>
            {provider.planLabel}
          </Text>
        ) : null}
      </View>
      {provider.hasData ? (
        <>
          <QuotaGauge label={t("tasks.quota.rolling")} window={provider.session} />
          <QuotaGauge label={t("tasks.quota.weekly")} window={provider.weekly} />
          <QuotaForecastLine samples={samples} resetsAt={provider.weekly?.resetsAt ?? null} />
          <QuotaHistorySparkline samples={samples} />
        </>
      ) : (
        // A provider that answered nothing still gets a row, so its absence is
        // never mistaken for "this model has no quota".
        <Text style={styles.hint}>{provider.error ?? t("tasks.quota.unavailable")}</Text>
      )}
    </View>
  );
}

/** The localized weekday a run-out lands on, e.g. "jeudi". */
function weekdayName(at: number, language: string): string {
  try {
    return new Intl.DateTimeFormat(language, { weekday: "long" }).format(new Date(at));
  } catch {
    // Some runtimes ship a trimmed Intl; a plain date beats crashing the menu.
    return new Date(at).toLocaleDateString();
  }
}

/**
 * "At this rate, spent Thursday" — the one line that turns a gauge into a
 * decision. Silent unless the host's trace is long enough to mean something.
 */
function QuotaForecastLine({
  samples,
  resetsAt,
}: {
  samples: QuotaSample[];
  resetsAt: string | null;
}) {
  const { t, i18n } = useTranslation();
  const forecast = useMemo(() => forecastRunOut({ samples, resetsAt }), [samples, resetsAt]);

  if (forecast.kind === "unknown") {
    return null;
  }
  if (forecast.kind === "lasts") {
    return <Text style={styles.forecast}>{t("tasks.quota.forecastLasts")}</Text>;
  }

  const day = forecastDay(forecast.at);
  let when: string;
  if (day === "today") {
    when = t("tasks.quota.forecastToday");
  } else if (day === "tomorrow") {
    when = t("tasks.quota.forecastTomorrow");
  } else {
    when = weekdayName(forecast.at, i18n.language);
  }
  return <Text style={styles.forecastWarn}>{t("tasks.quota.forecastRunsOut", { when })}</Text>;
}

/**
 * Seven-day trace of the weekly allowance still left, as recorded by the host.
 * Absent until there are two readings far enough apart, so it never shows a flat
 * line pretending to be a week.
 */
function QuotaHistorySparkline({ samples }: { samples: QuotaSample[] }) {
  const { t } = useTranslation();
  const points = useMemo(() => sparklinePoints(samples, SPARKLINE_SIZE), [samples]);
  if (!points) {
    return null;
  }
  return (
    <View style={styles.sparkline}>
      <Text style={styles.sparklineLabel}>{t("tasks.quota.history")}</Text>
      <Svg
        width="100%"
        height={SPARKLINE_SIZE.height}
        viewBox={`0 0 ${SPARKLINE_SIZE.width} ${SPARKLINE_SIZE.height}`}
        preserveAspectRatio="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <ThemedPolyline
          points={points}
          fill="none"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          uniProps={sparklineColorMapping}
        />
      </Svg>
    </View>
  );
}

const RESET_KEY_BY_UNIT = {
  minutes: "tasks.quota.resetsInMinutes",
  hours: "tasks.quota.resetsInHours",
  days: "tasks.quota.resetsInDays",
} as const;

/** One window: a label, how much is left, and when it refills. */
function QuotaGauge({ label, window }: { label: string; window: ProviderUsageWindow | null }) {
  const { t } = useTranslation();
  const remaining = remainingPercent(window);
  const tone = toneForRemaining(remaining);
  const countdown = resetCountdown(window?.resetsAt);

  const fillStyle = useMemo<StyleProp<ViewStyle>>(
    () => [
      styles.gaugeFill,
      tone === "warn" && styles.gaugeFillWarn,
      tone === "danger" && styles.gaugeFillDanger,
      { width: `${remaining ?? 0}%` as const },
    ],
    [remaining, tone],
  );

  return (
    <View style={styles.gauge}>
      <View style={styles.gaugeHeader}>
        <Text style={styles.gaugeLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={tone === "danger" ? styles.gaugeValueDanger : styles.gaugeValue}>
          {remaining === null
            ? t("tasks.quota.noData")
            : t("tasks.quota.remaining", { percent: Math.round(remaining) })}
        </Text>
      </View>
      <View style={styles.gaugeTrack}>
        <View style={fillStyle} />
      </View>
      {countdown ? (
        <Text style={styles.gaugeReset}>
          {t(RESET_KEY_BY_UNIT[countdown.unit], { count: countdown.count })}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  // A chip, not a bare glyph: sat among four plain icons the ring read as noise
  // and was missed entirely. The quiet surface + outline makes it a control you
  // can find without hunting, while staying calmer than a coloured button.
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    minWidth: 32,
    height: 32,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface2,
  },
  triggerValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontVariant: ["tabular-nums"],
  },
  triggerValueDanger: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
  },
  // Start the arc at 12 o'clock instead of 3 o'clock.
  ring: {
    transform: [{ rotate: "-90deg" }],
  },
  // The dropdown surface carries no padding of its own — its built-in rows each
  // bring theirs. This menu draws its own content, so it has to inset itself or
  // every label ends up welded to the border.
  menu: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  menuTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  provider: {
    gap: theme.spacing[2],
  },
  providerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  providerName: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  providerPlan: {
    // Without this the plan label refuses to shrink and runs off the surface.
    flexShrink: 1,
    textAlign: "right",
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  gauge: {
    gap: theme.spacing[1],
  },
  gaugeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  gaugeLabel: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  gaugeValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontVariant: ["tabular-nums"],
  },
  gaugeValueDanger: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
  },
  gaugeTrack: {
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  gaugeFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  gaugeFillWarn: {
    backgroundColor: theme.colors.palette.amber[500],
  },
  gaugeFillDanger: {
    backgroundColor: theme.colors.destructive,
  },
  gaugeReset: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  forecast: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  forecastWarn: {
    color: theme.colors.palette.amber[500],
    fontSize: theme.fontSize.xs,
  },
  sparkline: {
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  sparklineLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

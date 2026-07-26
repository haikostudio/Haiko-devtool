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
import type { ProviderUsageWindow } from "@/provider-usage/types";
import { useQuotaHistoryStore } from "@/stores/quota-history-store";
import type { Theme } from "@/styles/theme";
import { sparklinePoints, type QuotaSample } from "./task-quota-history";
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

const trackColorMapping = (theme: Theme) => ({ stroke: theme.colors.surface3 });
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
      return theme.colors.foregroundMuted;
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

  const summary = useMemo(
    () => buildQuotaSummary(view.kind === "ready" ? view.payload : null),
    [view],
  );

  // Every fresh reading feeds the seven-day curve and, once, the low-quota
  // warning. Both live here rather than in the menu so they keep working while
  // the menu is closed — a warning you only see after opening it is useless.
  useEffect(() => {
    const history = useQuotaHistoryStore.getState();
    for (const provider of summary.providers) {
      const remaining = remainingPercent(provider.weekly);
      if (remaining === null) continue;
      history.record(provider.providerId, { t: Date.now(), remainingPct: remaining });

      if (remaining > REMAINING_DANGER_PCT) {
        history.clearWarned(provider.providerId);
        continue;
      }
      const resetKey = provider.weekly?.resetsAt ?? "current";
      if (!history.shouldWarn(provider.providerId, resetKey)) continue;
      history.markWarned(provider.providerId, resetKey);
      toast.show(
        t("tasks.quota.lowAlert", {
          provider: provider.displayName,
          percent: Math.round(remaining),
        }),
        { variant: "warning", durationMs: 6000 },
      );
    }
  }, [summary, t, toast]);

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

  const remaining = summary.weeklyRemainingPct;
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
        {/* The number is worth the width on a desktop header; on a phone the
            header is already tight, so the ring speaks alone there. */}
        {isCompact || remaining === null ? null : (
          <Text style={tone === "danger" ? styles.triggerValueDanger : styles.triggerValue}>
            {t("tasks.quota.percentShort", { percent: Math.round(remaining) })}
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
            <QuotaProviderBlock key={provider.providerId} provider={provider} />
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

function QuotaProviderBlock({ provider }: { provider: QuotaProviderSummary }) {
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
          <QuotaHistorySparkline providerId={provider.providerId} />
        </>
      ) : (
        <Text style={styles.hint}>{t("tasks.quota.unavailable")}</Text>
      )}
    </View>
  );
}

/**
 * Seven-day trace of the weekly allowance still left, drawn from readings this
 * device took. Absent until there are two readings far enough apart, so it never
 * shows a flat line pretending to be a week.
 */
function QuotaHistorySparkline({ providerId }: { providerId: string }) {
  const { t } = useTranslation();
  const samples = useQuotaHistoryStore(
    (state) => state.samplesByProvider[providerId] ?? NO_SAMPLES,
  );
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
  // Row, not a square: the ring keeps the 32px icon footprint of its neighbours
  // and the optional percentage extends it to the right.
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    minWidth: 32,
    height: 32,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface1,
  },
  triggerValue: {
    color: theme.colors.foregroundMuted,
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
  menu: {
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[1],
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

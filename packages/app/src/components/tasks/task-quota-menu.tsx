import { useCallback, useMemo, useState } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { useTranslation } from "react-i18next";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProviderUsage } from "@/provider-usage/use-provider-usage";
import type { ProviderUsageWindow } from "@/provider-usage/types";
import type { Theme } from "@/styles/theme";
import {
  buildQuotaSummary,
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

const trackColorMapping = (theme: Theme) => ({ stroke: theme.colors.surface3 });

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
  const [open, setOpen] = useState(false);
  const { view, refresh, canFetch } = useProviderUsage(serverId);

  const summary = useMemo(
    () => buildQuotaSummary(view.kind === "ready" ? view.payload : null),
    [view],
  );

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
        </>
      ) : (
        <Text style={styles.hint}>{t("tasks.quota.unavailable")}</Text>
      )}
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
  trigger: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface1,
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
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

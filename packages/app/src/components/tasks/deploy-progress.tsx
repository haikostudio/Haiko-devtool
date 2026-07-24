import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, Rocket, X } from "lucide-react-native";
import { useTasksBoardUiStore } from "@/stores/tasks-board-ui-store";
import type { Theme } from "@/styles/theme";

const ThemedRocket = withUnistyles(Rocket);
const ThemedCheck = withUnistyles(Check);
const ThemedX = withUnistyles(X);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);

const rocketColorMapping = (theme: Theme) => ({ color: theme.colors.primary });
const checkColorMapping = (theme: Theme) => ({ color: theme.colors.palette.white });
const dismissColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const spinnerColorMapping = (theme: Theme) => ({ color: theme.colors.primary });

/**
 * The deploy pipeline the conductor walks through after "Déployer". `untilMs` is a
 * rough elapsed-time boundary used to guess which step is live — the daemon does
 * not emit structured phase events yet, so this is an honest best-effort estimate,
 * not a measured progress. The last step (vérification) stays live until the user
 * dismisses the banner, since we have no "done" signal.
 */
const STEPS = [
  { key: "merge", label: "Fusion", untilMs: 20_000 },
  { key: "build", label: "Build", untilMs: 70_000 },
  { key: "publish", label: "Publication", untilMs: 95_000 },
  { key: "restart", label: "Redémarrage", untilMs: 115_000 },
  { key: "verify", label: "Vérification", untilMs: Number.POSITIVE_INFINITY },
] as const;

// Cap the bar just under full: without a completion signal we never claim 100%.
const FULL_FRACTION = 0.96;
const BAR_ESTIMATE_MS = 130_000;

/** One step in the stepper: a dot (check when done, spinner when live) + label. */
function DeployStep({ label, done, active }: { label: string; done: boolean; active: boolean }) {
  const dotStyle = useMemo(
    () => [styles.dot, done ? styles.dotDone : null, active ? styles.dotActive : null],
    [done, active],
  );
  const labelStyle = useMemo(
    () => [styles.stepLabel, active ? styles.stepLabelActive : null],
    [active],
  );
  return (
    <View style={styles.step}>
      <View style={dotStyle}>
        <DeployStepDot done={done} active={active} />
      </View>
      <Text style={labelStyle} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

/** The mark inside a step's dot: a check when done, a spinner when live, else empty. */
function DeployStepDot({ done, active }: { done: boolean; active: boolean }) {
  if (done) return <ThemedCheck size={10} uniProps={checkColorMapping} />;
  if (active) return <ThemedActivityIndicator size="small" uniProps={spinnerColorMapping} />;
  return null;
}

/**
 * A compact visual stepper shown at the top of the conductor dock while a deploy
 * is in flight, so the user watches the run advance (fusion → build → publication
 * → redémarrage → vérification) instead of parsing raw chat text. Purely visual and
 * time-estimated — it never drives the deploy, only mirrors its rough stage.
 */
export function DeployProgress() {
  const startedAt = useTasksBoardUiStore((state) => state.deployStartedAt);
  const clearDeployProgress = useTasksBoardUiStore((state) => state.clearDeployProgress);

  // Tick once a second while a deploy banner is showing so the estimated stage and
  // bar advance on their own. The interval only lives while `startedAt` is set.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const elapsed = startedAt === null ? 0 : Math.max(0, now - startedAt);
  const activeIndex = useMemo(() => STEPS.findIndex((step) => elapsed < step.untilMs), [elapsed]);
  const currentIndex = activeIndex === -1 ? STEPS.length - 1 : activeIndex;
  const fraction = Math.min(FULL_FRACTION, elapsed / BAR_ESTIMATE_MS);
  const fillStyle = useMemo(
    () => [styles.fill, { width: `${Math.round(fraction * 100)}%` as const }],
    [fraction],
  );

  if (startedAt === null) return null;

  return (
    <View style={styles.container} testID="deploy-progress">
      <View style={styles.headerRow}>
        <ThemedRocket size={16} uniProps={rocketColorMapping} />
        <Text style={styles.title}>Déploiement en cours…</Text>
        <Pressable
          onPress={clearDeployProgress}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Masquer la progression du déploiement"
          testID="deploy-progress-dismiss"
        >
          <ThemedX size={16} uniProps={dismissColorMapping} />
        </Pressable>
      </View>

      <View style={styles.track}>
        <View style={fillStyle} />
      </View>

      <View style={styles.steps}>
        {STEPS.map((step, index) => (
          <DeployStep
            key={step.key}
            label={step.label}
            done={index < currentIndex}
            active={index === currentIndex}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.foreground,
  },
  track: {
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  fill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.primary,
  },
  steps: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1],
  },
  step: {
    flex: 1,
    alignItems: "center",
    gap: theme.spacing[1],
  },
  dot: {
    width: theme.spacing[4],
    height: theme.spacing[4],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  dotDone: {
    backgroundColor: theme.colors.palette.green[400],
    borderColor: theme.colors.palette.green[400],
  },
  dotActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface0,
  },
  stepLabel: {
    fontSize: Math.round(theme.fontSize.xs * 0.92),
    textAlign: "center",
    color: theme.colors.foregroundMuted,
  },
  stepLabelActive: {
    color: theme.colors.foreground,
    fontWeight: "700",
  },
}));

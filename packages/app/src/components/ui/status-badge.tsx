import { useMemo } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

type StatusBadgeVariant = "success" | "error" | "warning" | "muted";

interface StatusBadgeProps {
  label: string;
  variant?: StatusBadgeVariant;
}

export function StatusBadge({ label, variant = "muted" }: StatusBadgeProps) {
  const pillStyle = useMemo(
    () => [
      styles.pill,
      variant === "success" && styles.pillSuccess,
      variant === "error" && styles.pillError,
      variant === "warning" && styles.pillWarning,
    ],
    [variant],
  );
  const textStyle = useMemo(
    () => [
      styles.pillText,
      variant === "success" && styles.pillTextSuccess,
      variant === "error" && styles.pillTextError,
      variant === "warning" && styles.pillTextWarning,
    ],
    [variant],
  );

  return (
    <View style={pillStyle}>
      <Text style={textStyle}>{label}</Text>
    </View>
  );
}

// Tinted pills (docs/design.md §12): status-colored text on a 10%-alpha
// background of the same color. Every variant also carries a hairline frame in
// the same status color (~40% alpha) so the badge always reads as a distinct
// "cadre + fond coloré" chip — the faint 10% fill on its own was too subtle to
// separate the status from the card text. The status colors are theme-adaptive
// (darker in light themes, brighter in dark), so tint and frame stay readable on
// both without per-theme branches.
const styles = StyleSheet.create((theme) => ({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  pillSuccess: {
    backgroundColor: `${theme.colors.statusSuccess}1A`,
    borderColor: `${theme.colors.statusSuccess}66`,
  },
  pillError: {
    backgroundColor: `${theme.colors.statusDanger}1A`,
    borderColor: `${theme.colors.statusDanger}66`,
  },
  pillWarning: {
    backgroundColor: `${theme.colors.statusWarning}1A`,
    borderColor: `${theme.colors.statusWarning}66`,
  },
  pillText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  pillTextSuccess: {
    color: theme.colors.statusSuccess,
  },
  pillTextError: {
    color: theme.colors.statusDanger,
  },
  pillTextWarning: {
    color: theme.colors.statusWarning,
  },
}));

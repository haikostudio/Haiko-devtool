import { memo } from "react";
import { Text, View } from "react-native";
import { TriangleAlert } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { DaemonBuildFreshness } from "@/components/tasks/use-daemon-build-freshness";

const warningColorMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const ThemedWarning = withUnistyles(TriangleAlert);

/**
 * The board's own warning that the engine is not running the published version.
 *
 * The daemon executes compiled code: a publication that put the site online
 * without rebuilding the engine leaves everything LOOKING right — the commit is
 * in, the site is up — while the running engine is still the previous build and
 * the fix does nothing. That failure used to be invisible for a whole day. A
 * notification now goes out at boot; this is the same truth, on the board, where
 * the work it silently affects is.
 *
 * Renders nothing when the versions match or cannot be known.
 */
export const StaleEngineBanner = memo(function StaleEngineBanner({
  freshness,
}: {
  freshness: DaemonBuildFreshness | null;
}) {
  const { t } = useTranslation();
  if (!freshness) {
    return null;
  }
  return (
    <View style={styles.card} testID="tasks-stale-engine-banner">
      <View style={styles.header}>
        <ThemedWarning size={ICON_SIZE.sm} uniProps={warningColorMapping} />
        <Text style={styles.title}>{t("tasks.board.staleEngineTitle")}</Text>
      </View>
      <Text style={styles.detail}>
        {t("tasks.board.staleEngineDetail", {
          built: freshness.builtSha.slice(0, 8),
          deployed: freshness.deployedSha.slice(0, 8),
        })}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    marginBottom: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  detail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));

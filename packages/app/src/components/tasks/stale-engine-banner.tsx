import { RotateCw } from "lucide-react-native";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { DaemonBuildFreshness } from "@/components/tasks/use-daemon-build-freshness";

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
  onUpdate,
  progressLabel,
}: {
  freshness: DaemonBuildFreshness | null;
  onUpdate: () => void;
  progressLabel: string | null;
}) {
  const { t } = useTranslation();
  const action = useMemo(
    () => (
      <Button
        variant="outline"
        size="sm"
        leftIcon={RotateCw}
        loading={progressLabel !== null}
        disabled={progressLabel !== null}
        onPress={onUpdate}
        accessibilityLabel={progressLabel ?? t("tasks.board.staleEngineAction")}
        testID="tasks-stale-engine-update"
      />
    ),
    [onUpdate, progressLabel, t],
  );

  if (!freshness) {
    return null;
  }

  return (
    <View style={styles.container}>
      <Alert
        title={progressLabel ?? t("tasks.board.staleEngineTitle")}
        variant="warning"
        testID="tasks-stale-engine-banner"
        action={action}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    marginHorizontal: theme.spacing[3],
  },
}));

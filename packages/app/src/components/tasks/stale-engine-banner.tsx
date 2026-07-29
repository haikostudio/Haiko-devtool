import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
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
}: {
  freshness: DaemonBuildFreshness | null;
  onUpdate: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [isUpdating, setIsUpdating] = useState(false);

  const handleUpdate = useCallback(() => {
    if (isUpdating) return;
    setIsUpdating(true);
    void onUpdate().finally(() => setIsUpdating(false));
  }, [isUpdating, onUpdate]);

  if (!freshness) {
    return null;
  }

  return (
    <Alert
      title={t("tasks.board.staleEngineTitle")}
      variant="warning"
      testID="tasks-stale-engine-banner"
    >
      <Button
        variant="outline"
        size="sm"
        loading={isUpdating}
        disabled={isUpdating}
        onPress={handleUpdate}
        testID="tasks-stale-engine-update"
      >
        {isUpdating ? t("tasks.board.staleEngineUpdating") : t("tasks.board.staleEngineAction")}
      </Button>
    </Alert>
  );
});

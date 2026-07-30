import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { ScrollableCodeSurface } from "@/components/ui/scrollable-code-surface";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

/** How often the publication's output is re-read while the sheet is open. */
const POLL_INTERVAL_MS = 3_000;

/**
 * The publication's own log, live.
 *
 * A publication is a build script, not an agent: there is no conversation to
 * open and watch. Its output is therefore the only account of what is happening
 * — which phase is running, which command refused, why nothing went online — so
 * it has to be reachable in one tap from the progress banner rather than left on
 * the server for someone with an SSH session.
 *
 * Polling (rather than streaming) is deliberate: the daemon already exposes the
 * publication status on a request/response RPC, the log is bounded to its last
 * few KB, and a three-second refresh reads as live for a five-minute build.
 */
export function DeployLogSheet({
  serverId,
  visible,
  onClose,
}: {
  serverId: string | null;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const [log, setLog] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Kept in a ref so the polling effect doesn't restart on every refresh.
  const disposed = useRef(false);

  const read = useCallback(async () => {
    if (!client) {
      return;
    }
    try {
      const status = await client.paseoDeployStatus();
      if (disposed.current) {
        return;
      }
      setLog(status.deployLog ?? null);
      setPhase(status.deployPhase ?? null);
      setFailed(status.deployOutcome === "failed");
    } catch {
      // A host that doesn't know this RPC, or a hiccup mid-build: keep whatever
      // was already read instead of blanking the log the user is reading.
    }
  }, [client]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    disposed.current = false;
    void read();
    const timer = setInterval(() => void read(), POLL_INTERVAL_MS);
    return () => {
      disposed.current = true;
      clearInterval(timer);
    };
  }, [visible, read]);

  const header = useMemo(
    () => ({
      title: t("tasks.board.deployLogTitle"),
      subtitle: phase
        ? t(`tasks.board.batchPhase.${phase}`, { defaultValue: phase })
        : t("tasks.board.deployLogEmpty"),
    }),
    [phase, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      scrollable={false}
      testID="tasks-deploy-log-sheet"
    >
      <View style={styles.body}>
        {log ? (
          <ScrollableCodeSurface
            selectable
            bordered
            maxHeight={520}
            testID="tasks-deploy-log-content"
          >
            {log}
          </ScrollableCodeSurface>
        ) : (
          <Text style={styles.empty}>{t("tasks.board.deployLogEmpty")}</Text>
        )}
        {failed ? <Text style={styles.failed}>{t("tasks.board.deployLogFailed")}</Text> : null}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[2],
  },
  empty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  failed: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
}));

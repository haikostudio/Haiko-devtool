import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Rocket } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { usePaseoDeployStatus } from "@/git/use-paseo-deploy";
import type { Theme } from "@/styles/theme";

const ThemedRocket = withUnistyles(Rocket);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);

const rocketColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.white,
});
const spinnerColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.white,
});

interface PaseoDeployButtonProps {
  serverId: string;
}

/**
 * "Publier tout" — Paseo self-host deploy button for the desktop workspace
 * header. Rendered only for the Paseo repo itself and only when the host
 * advertises the `paseoSelfhostDeploy` capability (gated by the caller).
 */
export function PaseoDeployButton({ serverId }: PaseoDeployButtonProps) {
  const [open, setOpen] = useState(false);
  const { status, pendingCount, refetch } = usePaseoDeployStatus({ serverId, enabled: true });

  const deploying = status?.deploying ?? false;
  const hasPending = status?.hasPending ?? false;

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);

  return (
    <>
      <Pressable
        testID="paseo-deploy-button"
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel="Déployer Paseo"
        style={styles.button}
      >
        {deploying ? (
          <ThemedActivityIndicator size="small" uniProps={spinnerColorMapping} />
        ) : (
          <ThemedRocket size={16} uniProps={rocketColorMapping} />
        )}
        {!deploying && hasPending ? (
          <View style={styles.badge}>
            {pendingCount > 0 ? <Text style={styles.badgeText}>{pendingCount}</Text> : null}
          </View>
        ) : null}
      </Pressable>
      <PaseoDeployModal
        visible={open}
        serverId={serverId}
        status={status}
        onClose={handleClose}
        onDeployed={refetch}
      />
    </>
  );
}

interface PaseoDeployModalProps {
  visible: boolean;
  serverId: string;
  status: ReturnType<typeof usePaseoDeployStatus>["status"];
  onClose: () => void;
  onDeployed: () => void;
}

function PaseoDeployModal({
  visible,
  serverId,
  status,
  onClose,
  onDeployed,
}: PaseoDeployModalProps) {
  const client = useHostRuntimeClient(serverId);
  const [triggering, setTriggering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sheetHeader = useMemo<SheetHeader>(() => ({ title: "À déployer" }), []);

  const deploying = status?.deploying ?? false;
  const uncommittedFiles = status?.uncommittedFiles ?? [];
  const unshippedCommits = status?.unshippedCommits ?? [];
  const isClean = !deploying && uncommittedFiles.length === 0 && unshippedCommits.length === 0;

  const trigger = useCallback(
    async (noBuild: boolean) => {
      if (!client || triggering || deploying) return;
      setError(null);
      setTriggering(true);
      try {
        const result = await client.paseoDeployTrigger(noBuild ? { noBuild: true } : undefined);
        if (!result.started && result.error) {
          setError(result.error);
        }
        onDeployed();
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : "Échec du déclenchement.");
      } finally {
        setTriggering(false);
      }
    },
    [client, triggering, deploying, onDeployed],
  );

  const handleDeploy = useCallback(() => {
    void trigger(false);
  }, [trigger]);

  const handleCommitOnly = useCallback(() => {
    void trigger(true);
  }, [trigger]);

  const busy = triggering || deploying;

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={sheetHeader}
      testID="paseo-deploy-modal"
    >
      <View style={styles.body}>
        {isClean ? <Text style={styles.cleanText}>Tout est déjà en ligne. ✅</Text> : null}

        {uncommittedFiles.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Modifications non enregistrées</Text>
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {uncommittedFiles.map((file) => (
                <View key={file.path} style={styles.row}>
                  <Text style={styles.rowStatus}>{file.status}</Text>
                  <Text style={styles.rowText} numberOfLines={1}>
                    {file.path}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {unshippedCommits.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Commits pas encore en ligne</Text>
            <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
              {unshippedCommits.map((commit) => (
                <View key={commit.sha} style={styles.row}>
                  <Text style={styles.rowStatus}>{commit.sha.slice(0, 7)}</Text>
                  <Text style={styles.rowText} numberOfLines={1}>
                    {commit.subject}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
        ) : null}

        {deploying ? <Text style={styles.infoText}>Déploiement en cours…</Text> : null}

        {status?.lastError ? (
          <View style={styles.warning}>
            <Text style={styles.warningText}>{status.lastError}</Text>
          </View>
        ) : null}

        {error ? (
          <View style={styles.warning}>
            <Text style={styles.warningText}>{error}</Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            style={styles.actionButton}
            onPress={onClose}
            disabled={triggering}
            testID="paseo-deploy-cancel"
          >
            Fermer
          </Button>
          <Button
            variant="secondary"
            size="sm"
            style={styles.actionButton}
            onPress={handleCommitOnly}
            disabled={busy}
            testID="paseo-deploy-commit-only"
          >
            Enregistrer sans publier
          </Button>
          <Button
            variant="default"
            size="sm"
            style={styles.actionButton}
            onPress={handleDeploy}
            disabled={busy}
            testID="paseo-deploy-confirm"
          >
            {deploying ? "Déploiement…" : "Déployer"}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    minHeight: Math.ceil(theme.fontSize.sm * 1.5) + theme.spacing[1] * 2,
    minWidth: Math.ceil(theme.fontSize.sm * 1.5) + theme.spacing[1] * 2,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.palette.black,
  },
  badge: {
    minWidth: theme.spacing[4],
    height: theme.spacing[4],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.spacing[2],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primary,
  },
  badgeText: {
    fontSize: Math.round(theme.fontSize.xs * 0.9),
    lineHeight: theme.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.primaryForeground,
  },
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  cleanText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
  list: {
    maxHeight: 160,
  },
  listContent: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowStatus: {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    minWidth: theme.spacing[8],
  },
  rowText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  infoText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  warning: {
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.palette.red[900],
  },
  warningText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[200],
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));

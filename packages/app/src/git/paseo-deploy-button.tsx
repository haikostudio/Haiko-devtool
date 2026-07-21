import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
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
// Compact (mobile header) uses the header's monochrome look instead of the
// black pill, so the rocket matches the neighbouring play / source-control icons.
const compactRocketColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const compactSpinnerColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

/** Turn a git short-status code (e.g. "M", "A", "??") into a plain French word. */
function describeFileStatus(status: string): string {
  const code = status.trim();
  if (code === "??") return "Nouveau fichier";
  switch (code[0] ?? "") {
    case "A":
      return "Ajouté";
    case "M":
      return "Modifié";
    case "D":
      return "Supprimé";
    case "R":
      return "Renommé";
    case "C":
      return "Copié";
    case "U":
      return "Conflit à résoudre";
    default:
      return "Modifié";
  }
}

/** Show just the file name plus its folder, without the noisy leading path. */
function describeFilePath(path: string): string {
  const parts = path.split("/").filter((segment) => segment.length > 0);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}

/**
 * Strip a leading conventional-commit prefix like "feat(scope): " so the reader
 * sees the plain sentence instead of developer jargon.
 */
function humanizeCommitSubject(subject: string): string {
  const stripped = subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").trim();
  if (stripped.length === 0) return subject;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/**
 * Prominent tally shown at the top of the deploy sheet — the real number of
 * changes to ship, so the reader sees the volume before scanning the lists.
 */
function DeployChangesSummary({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.summary}>
      <Text style={styles.summaryCount}>{count}</Text>
      <Text style={styles.summaryLabel}>
        {count > 1 ? "changements à publier" : "changement à publier"}
      </Text>
    </View>
  );
}

interface PaseoDeployButtonProps {
  serverId: string;
  /**
   * Compact icon-only rendering for the mobile header row (matches the other
   * header icon buttons). Desktop keeps the black pill.
   */
  compact?: boolean;
}

/**
 * "Publier tout" — Paseo self-host deploy button for the workspace header.
 * Rendered only for the Paseo repo itself and only when the host advertises
 * the `paseoSelfhostDeploy` capability (gated by the caller).
 */
export function PaseoDeployButton({ serverId, compact = false }: PaseoDeployButtonProps) {
  const [open, setOpen] = useState(false);
  const { status, pendingCount, refetch } = usePaseoDeployStatus({ serverId, enabled: true });

  const deploying = status?.deploying ?? false;
  const hasPending = status?.hasPending ?? false;

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);

  const iconSize = compact ? 20 : 16;
  const rocketColors = compact ? compactRocketColorMapping : rocketColorMapping;
  const spinnerColors = compact ? compactSpinnerColorMapping : spinnerColorMapping;

  return (
    <>
      <Pressable
        testID="paseo-deploy-button"
        onPress={handleOpen}
        accessibilityRole="button"
        accessibilityLabel="Déployer Paseo"
        style={compact ? styles.buttonCompact : styles.button}
      >
        {deploying ? (
          <ThemedActivityIndicator size="small" uniProps={spinnerColors} />
        ) : (
          <ThemedRocket size={iconSize} uniProps={rocketColors} />
        )}
        {!deploying && hasPending ? (
          <View style={compact ? styles.badgeCompact : styles.badge}>
            {pendingCount > 0 ? (
              <Text style={compact ? styles.badgeTextCompact : styles.badgeText}>
                {pendingCount > 99 ? "99+" : pendingCount}
              </Text>
            ) : null}
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
  // Real number of changes to ship — honest even after work is grouped into a
  // few commits (older daemons that don't send it fall back to the list sum).
  const changesCount = status?.changesCount ?? uncommittedFiles.length + unshippedCommits.length;

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

  // Actions live in the sheet's sticky footer so they stay pinned to the bottom
  // edge instead of scrolling away with the change list.
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button
          variant="default"
          size="sm"
          style={styles.actionButton}
          textStyle={styles.actionButtonText}
          onPress={handleDeploy}
          disabled={busy}
          testID="paseo-deploy-confirm"
        >
          {deploying ? "Publication en cours…" : "Publier maintenant"}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          style={styles.actionButton}
          textStyle={styles.actionButtonText}
          onPress={handleCommitOnly}
          disabled={busy}
          testID="paseo-deploy-commit-only"
        >
          Enregistrer sans publier
        </Button>
        <Button
          variant="secondary"
          size="sm"
          style={styles.actionButton}
          textStyle={styles.actionButtonText}
          onPress={onClose}
          disabled={triggering}
          testID="paseo-deploy-cancel"
        >
          Fermer
        </Button>
      </View>
    ),
    [busy, deploying, triggering, handleDeploy, handleCommitOnly, onClose],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={sheetHeader}
      footer={footer}
      testID="paseo-deploy-modal"
    >
      <View style={styles.body}>
        {isClean ? <Text style={styles.cleanText}>Tout est déjà en ligne. ✅</Text> : null}

        {isClean ? null : <DeployChangesSummary count={changesCount} />}

        {uncommittedFiles.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Modifications en cours, pas encore enregistrées</Text>
            <View style={styles.list}>
              {uncommittedFiles.map((file) => (
                <View key={file.path} style={styles.itemRow}>
                  <Text style={styles.bullet}>•</Text>
                  <Text style={styles.itemText}>
                    <Text style={styles.itemLabel}>{describeFileStatus(file.status)} : </Text>
                    {describeFilePath(file.path)}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {unshippedCommits.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Changements prêts, pas encore en ligne</Text>
            <View style={styles.list}>
              {unshippedCommits.map((commit) => (
                <View key={commit.sha} style={styles.itemRow}>
                  <Text style={styles.bullet}>•</Text>
                  <Text style={styles.itemText}>{humanizeCommitSubject(commit.subject)}</Text>
                </View>
              ))}
            </View>
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
  // Mobile header icon button — matches styles.headerActionButton in the
  // workspace header (icon-only, transparent, same touch target).
  buttonCompact: {
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  // Small count pill overlapping the top-right of the mobile icon.
  badgeCompact: {
    position: "absolute",
    top: 0,
    right: 0,
    minWidth: theme.spacing[4],
    height: theme.spacing[4],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.spacing[2],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.primary,
  },
  badgeTextCompact: {
    fontSize: Math.round(theme.fontSize.xs * 0.85),
    lineHeight: theme.fontSize.xs,
    fontWeight: "700",
    color: theme.colors.primaryForeground,
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
  // Prominent tally at the very top so the reader sees the real volume of work
  // at a glance, before scanning the per-file / per-commit lists below.
  summary: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  summaryCount: {
    fontSize: theme.fontSize.xl,
    fontWeight: "800",
    color: theme.colors.foreground,
  },
  summaryLabel: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
  // The whole change list flows into the sheet's single scroll region — no inner
  // maxHeight box, so the drawer scrolls as one instead of cramming rows into a
  // tiny nested scroller while the sheet stays half-empty.
  list: {
    gap: theme.spacing[1],
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  bullet: {
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
    color: theme.colors.foregroundMuted,
  },
  itemText: {
    flex: 1,
    fontSize: theme.fontSize.base,
    lineHeight: theme.fontSize.base * 1.4,
    color: theme.colors.foreground,
  },
  itemLabel: {
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
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
  // Stacked (one under the other) on narrow screens, side by side on wide ones.
  // flex:1 lets the group fill the sticky footer's row so the buttons span the
  // full sheet width instead of hugging their text.
  actions: {
    flex: 1,
    flexDirection: { xs: "column", md: "row" },
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: { xs: 0, md: 1 },
    paddingHorizontal: theme.spacing[2],
  },
  // Smaller label so long actions like "Enregistrer sans publier" stay on a
  // single line inside the side-by-side desktop footer instead of wrapping.
  actionButtonText: {
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
}));

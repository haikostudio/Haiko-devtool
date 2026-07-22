import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Rocket } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  type PaseoDeployCommitEntry,
  type PaseoDeployFileEntry,
  type PaseoDeployWorktreeEntry,
  usePaseoDeployStatus,
} from "@/git/use-paseo-deploy";
import type { Theme } from "@/styles/theme";

// Stable empty arrays so the list props keep a constant identity when the status
// hasn't loaded yet (avoids needless re-renders of the list sections).
const EMPTY_FILES: PaseoDeployFileEntry[] = [];
const EMPTY_COMMITS: PaseoDeployCommitEntry[] = [];
const EMPTY_WORKTREES: PaseoDeployWorktreeEntry[] = [];

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

/**
 * Warning shown at the top of the deploy sheet when daemon-side work has shipped
 * since the engine last started — those features stay dormant until a restart,
 * which is exactly the "I don't see my changes" trap. Restart is a manual,
 * human-triggered action, so this only informs; it never acts.
 */
function DaemonBehindNotice({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <View style={styles.behind}>
      <Text style={styles.behindTitle}>
        {count > 1
          ? `Le moteur est en retard sur ${count} nouveautés`
          : "Le moteur est en retard sur 1 nouveauté"}
      </Text>
      <Text style={styles.behindText}>
        {count > 1
          ? "Ces changements sont enregistrés mais dorment tant que le moteur n'a pas redémarré. Redémarre-le pour les activer."
          : "Ce changement est enregistré mais dort tant que le moteur n'a pas redémarré. Redémarre-le pour l'activer."}
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

/** "Modifications en cours, pas encore enregistrées" list (hidden when empty). */
function PendingFilesSection({ files }: { files: PaseoDeployFileEntry[] }) {
  if (files.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Modifications en cours, pas encore enregistrées</Text>
      <View style={styles.list}>
        {files.map((file) => (
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
  );
}

/** "Changements prêts, pas encore en ligne" list (hidden when empty). */
function PendingCommitsSection({ commits }: { commits: PaseoDeployCommitEntry[] }) {
  if (commits.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Changements prêts, pas encore en ligne</Text>
      <View style={styles.list}>
        {commits.map((commit) => (
          <View key={commit.sha} style={styles.itemRow}>
            <Text style={styles.bullet}>•</Text>
            <Text style={styles.itemText}>{humanizeCommitSubject(commit.subject)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/** Turn a branch ref (e.g. "task/page-config-…-a55b11") into a short label. */
function describeBranch(branch: string): string {
  const segments = branch.split("/");
  const tail = segments[segments.length - 1] || branch;
  // Drop a trailing "-<6 hex>" task suffix so the label stays readable.
  return tail.replace(/-[0-9a-f]{6,}$/i, "");
}

/** Uncommitted-files hint for an atelier card (info only; shipping needs a commit). */
function WorktreeUncommittedHint({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Text style={styles.worktreeHint}>
      {count > 1
        ? `${count} fichiers non enregistrés dans cet atelier (à enregistrer avant publication)`
        : "1 fichier non enregistré dans cet atelier (à enregistrer avant publication)"}
    </Text>
  );
}

/** One atelier card — its pending commits plus a merge-and-publish action. */
function WorktreeCard({
  worktree,
  onPublishBranch,
  busy,
  pendingBranch,
}: {
  worktree: PaseoDeployWorktreeEntry;
  onPublishBranch: (branch: string) => void;
  busy: boolean;
  pendingBranch: string | null;
}) {
  const handlePress = useCallback(
    () => onPublishBranch(worktree.branch),
    [onPublishBranch, worktree.branch],
  );
  return (
    <View style={styles.worktreeCard}>
      <Text style={styles.worktreeBranch}>{describeBranch(worktree.branch)}</Text>
      {worktree.commits.map((commit) => (
        <View key={commit.sha} style={styles.itemRow}>
          <Text style={styles.bullet}>•</Text>
          <Text style={styles.itemText}>{humanizeCommitSubject(commit.subject)}</Text>
        </View>
      ))}
      <WorktreeUncommittedHint count={worktree.uncommittedCount} />
      <Button
        variant="secondary"
        size="sm"
        style={styles.worktreeButton}
        textStyle={styles.actionButtonText}
        onPress={handlePress}
        disabled={busy || worktree.ahead === 0}
        testID={`paseo-deploy-merge-${worktree.branch}`}
      >
        {pendingBranch === worktree.branch ? "Publication en cours…" : "Fusionner & publier"}
      </Button>
    </View>
  );
}

/**
 * "Autres ateliers" — every other Paseo checkout (task-branch worktree) with work
 * not yet on the deploy branch. Each can be merged into the deploy branch and
 * shipped in one tap, so nothing a task did stays invisible.
 */
function WorktreesSection({
  worktrees,
  onPublishBranch,
  busy,
  pendingBranch,
}: {
  worktrees: PaseoDeployWorktreeEntry[];
  onPublishBranch: (branch: string) => void;
  busy: boolean;
  pendingBranch: string | null;
}) {
  if (worktrees.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Autres ateliers (branches de tâche)</Text>
      <View style={styles.worktreeList}>
        {worktrees.map((worktree) => (
          <WorktreeCard
            key={worktree.path}
            worktree={worktree}
            onPublishBranch={onPublishBranch}
            busy={busy}
            pendingBranch={pendingBranch}
          />
        ))}
      </View>
    </View>
  );
}

/** Red banner for a deploy error (last run failure or trigger error). */
function DeployErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <View style={styles.warning}>
      <Text style={styles.warningText}>{message}</Text>
    </View>
  );
}

/** Top-of-sheet header: "all live" line when clean, else the changes tally. */
function DeployStatusHeader({
  isClean,
  daemonBehindCount,
  changesCount,
}: {
  isClean: boolean;
  daemonBehindCount: number;
  changesCount: number;
}) {
  if (isClean) {
    return daemonBehindCount <= 0 ? (
      <Text style={styles.cleanText}>Tout est déjà en ligne. ✅</Text>
    ) : null;
  }
  return <DeployChangesSummary count={changesCount} />;
}

/** Scrollable contents of the deploy sheet — split out so the modal shell stays
 *  simple (and under the complexity budget). */
function DeployModalBody({
  status,
  error,
  onPublishBranch,
  busy,
  pendingBranch,
}: {
  status: ReturnType<typeof usePaseoDeployStatus>["status"];
  error: string | null;
  onPublishBranch: (branch: string) => void;
  busy: boolean;
  pendingBranch: string | null;
}) {
  const deploying = status?.deploying ?? false;
  const uncommittedFiles = status?.uncommittedFiles ?? EMPTY_FILES;
  const unshippedCommits = status?.unshippedCommits ?? EMPTY_COMMITS;
  const worktrees = status?.worktrees ?? EMPTY_WORKTREES;
  const isClean =
    !deploying &&
    uncommittedFiles.length === 0 &&
    unshippedCommits.length === 0 &&
    worktrees.length === 0;
  // Real number of changes to ship — honest even after work is grouped into a
  // few commits (older daemons that don't send it fall back to the list sum).
  const changesCount = status?.changesCount ?? uncommittedFiles.length + unshippedCommits.length;
  const daemonBehindCount = status?.daemonBehindCount ?? 0;

  return (
    <View style={styles.body}>
      <DaemonBehindNotice count={daemonBehindCount} />
      <DeployStatusHeader
        isClean={isClean}
        daemonBehindCount={daemonBehindCount}
        changesCount={changesCount}
      />

      <PendingFilesSection files={uncommittedFiles} />
      <PendingCommitsSection commits={unshippedCommits} />
      <WorktreesSection
        worktrees={worktrees}
        onPublishBranch={onPublishBranch}
        busy={busy}
        pendingBranch={pendingBranch}
      />

      {deploying ? <Text style={styles.infoText}>Déploiement en cours…</Text> : null}

      <DeployErrorBanner message={status?.lastError ?? null} />
      <DeployErrorBanner message={error} />
    </View>
  );
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
  // Branch currently being merged-and-shipped (for the per-atelier button label).
  const [pendingBranch, setPendingBranch] = useState<string | null>(null);

  const sheetHeader = useMemo<SheetHeader>(() => ({ title: "À déployer" }), []);

  const deploying = status?.deploying ?? false;

  const trigger = useCallback(
    async (input: { noBuild?: boolean; mergeBranch?: string }) => {
      if (!client || triggering || deploying) return;
      setError(null);
      setTriggering(true);
      setPendingBranch(input.mergeBranch ?? null);
      try {
        const result = await client.paseoDeployTrigger(input);
        if (!result.started && result.error) {
          setError(result.error);
        }
        onDeployed();
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : "Échec du déclenchement.");
      } finally {
        setTriggering(false);
        setPendingBranch(null);
      }
    },
    [client, triggering, deploying, onDeployed],
  );

  const handleDeploy = useCallback(() => {
    void trigger({});
  }, [trigger]);

  const handleCommitOnly = useCallback(() => {
    void trigger({ noBuild: true });
  }, [trigger]);

  const handlePublishBranch = useCallback(
    (branch: string) => {
      void trigger({ mergeBranch: branch });
    },
    [trigger],
  );

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
      <DeployModalBody
        status={status}
        error={error}
        onPublishBranch={handlePublishBranch}
        busy={busy}
        pendingBranch={pendingBranch}
      />
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
  // Per-atelier cards, each with its own merge-and-publish action.
  worktreeList: {
    gap: theme.spacing[2],
  },
  worktreeCard: {
    gap: theme.spacing[1],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  worktreeBranch: {
    fontSize: theme.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.foreground,
  },
  worktreeHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  worktreeButton: {
    marginTop: theme.spacing[1],
    alignSelf: "flex-start",
    paddingHorizontal: theme.spacing[2],
  },
  // "Engine is behind" hint — amber, distinct from the red error banner so it
  // reads as an actionable heads-up (restart me) rather than a failure.
  behind: {
    gap: theme.spacing[1],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.palette.amber[900],
  },
  behindTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.palette.amber[100],
  },
  behindText: {
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    color: theme.colors.palette.amber[200],
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

import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, ChevronDown, ChevronRight, Rocket } from "lucide-react-native";
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
const ThemedCheck = withUnistyles(Check);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const checkColorMapping = (theme: Theme) => ({
  color: theme.colors.primaryForeground,
});

const rocketColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.white,
});
const spinnerColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.white,
});
const progressSpinnerColorMapping = (theme: Theme) => ({
  color: theme.colors.primary,
});
const chevronColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
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
 * Overview line under the main tally: how much work waits across the OTHER
 * ateliers (task-branch worktrees), so the reader sees the spread at a glance
 * before scrolling. Hidden when nothing is pending in other ateliers.
 */
function WorktreesSummary({ worktrees }: { worktrees: PaseoDeployWorktreeEntry[] }) {
  if (worktrees.length === 0) return null;
  const total = worktrees.reduce(
    (sum, worktree) => sum + worktree.ahead + worktree.uncommittedCount,
    0,
  );
  const changeLabel = total > 1 ? "changements" : "changement";
  const atelierLabel = worktrees.length > 1 ? "ateliers" : "atelier";
  return (
    <Text style={styles.worktreesSummary}>
      {`${total} ${changeLabel} dans ${worktrees.length} ${atelierLabel}`}
    </Text>
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
  /**
   * Accepted for call-site compatibility (the tasks board passes its project id),
   * but no longer used: "Déployer" now triggers the daemon's local build directly
   * instead of delegating to the board's conductor agent.
   */
  projectId?: string | null;
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

/**
 * Human label for the current local-build phase reported by the daemon
 * (`deployPhase`). Drives both the footer button and the in-sheet progress line
 * so the user follows "Construction → Publication → En ligne". `triggering`
 * covers the brief gap before the first status poll reports a phase.
 */
function deployPhaseLabel(phase: string | null | undefined, triggering: boolean): string {
  switch (phase) {
    case "save":
      return "Sauvegarde…";
    case "build":
      return "Construction du site…";
    case "publish":
      return "Publication en ligne…";
    case "done":
      return "En ligne ✅";
    case "error":
      return "Échec du déploiement";
    default:
      return triggering ? "Démarrage…" : "Déploiement en cours…";
  }
}

const DEPLOY_PHASES = [
  { key: "save", label: "Sauvegarde", fraction: 0.2 },
  { key: "build", label: "Construction", fraction: 0.5 },
  { key: "publish", label: "Publication", fraction: 0.8 },
  { key: "done", label: "En ligne", fraction: 1 },
] as const;

/** Real coarse progress from the daemon; never estimates time inside a phase. */
function DeployPhaseProgress({
  deploying,
  phase,
}: {
  deploying: boolean;
  phase: string | null | undefined;
}) {
  const currentIndex = DEPLOY_PHASES.findIndex((entry) => entry.key === phase);
  const activeIndex = currentIndex < 0 ? 0 : currentIndex;
  const fraction = phase === "error" ? 0 : (DEPLOY_PHASES[activeIndex]?.fraction ?? 0);
  const fillStyle = useMemo(
    () => [styles.progressFill, { width: `${Math.round(fraction * 100)}%` as const }],
    [fraction],
  );
  if (!deploying && phase !== "done" && phase !== "error") return null;
  return (
    <View style={styles.progress} testID="paseo-deploy-progress">
      <View style={styles.progressHeader}>
        <Text style={styles.progressTitle}>
          {phase === "error" ? "Déploiement interrompu" : deployPhaseLabel(phase, true)}
        </Text>
        <Text style={styles.progressPercent}>{Math.round(fraction * 100)} %</Text>
      </View>
      <View style={styles.progressTrack}>
        <View style={fillStyle} />
      </View>
      <View style={styles.progressSteps}>
        {DEPLOY_PHASES.map((entry, index) => {
          const done = phase === "done" || (currentIndex >= 0 && index < currentIndex);
          const active = phase !== "error" && index === activeIndex;
          return (
            <DeployProgressStep
              key={entry.key}
              label={entry.label}
              done={done}
              active={active}
              deploying={deploying}
            />
          );
        })}
      </View>
    </View>
  );
}

function DeployProgressStep({
  label,
  done,
  active,
  deploying,
}: {
  label: string;
  done: boolean;
  active: boolean;
  deploying: boolean;
}) {
  const dotStyle = useMemo(
    () => [
      styles.progressDot,
      done ? styles.progressDotDone : null,
      active ? styles.progressDotActive : null,
    ],
    [active, done],
  );
  const labelStyle = useMemo(
    () => [styles.progressStepLabel, active ? styles.progressStepLabelActive : null],
    [active],
  );
  return (
    <View style={styles.progressStep}>
      <View style={dotStyle}>
        {done ? <ThemedCheck size={10} uniProps={checkColorMapping} /> : null}
        {active && deploying ? (
          <ThemedActivityIndicator size="small" uniProps={progressSpinnerColorMapping} />
        ) : null}
      </View>
      <Text style={labelStyle}>{label}</Text>
    </View>
  );
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

/** Small square checkbox (filled + check when on). Disabled ateliers show muted. */
function WorktreeCheckbox({ checked, disabled }: { checked: boolean; disabled: boolean }) {
  const boxStyle = useMemo(
    () => [
      styles.checkbox,
      checked ? styles.checkboxChecked : null,
      disabled ? styles.checkboxDisabled : null,
    ],
    [checked, disabled],
  );
  return (
    <View style={boxStyle}>
      {checked ? <ThemedCheck size={12} uniProps={checkColorMapping} /> : null}
    </View>
  );
}

/** One atelier card — compact header with expandable commit details. */
function WorktreeCard({
  worktree,
  selected,
  onToggle,
  onCommit,
  committing,
  busy,
}: {
  worktree: PaseoDeployWorktreeEntry;
  selected: boolean;
  onToggle: (branch: string) => void;
  onCommit: (path: string) => void;
  committing: boolean;
  busy: boolean;
}) {
  const mergeable = worktree.ahead > 0;
  const hasUncommitted = worktree.uncommittedCount > 0;
  const [expanded, setExpanded] = useState(false);
  const handleToggleExpand = useCallback(() => setExpanded((previous) => !previous), []);
  const handleToggleSelect = useCallback(() => {
    if (mergeable && !busy) onToggle(worktree.branch);
  }, [busy, mergeable, onToggle, worktree.branch]);
  // Stop the tap from also toggling the card's fold underneath the button.
  const handleCommit = useCallback(
    (event: { stopPropagation?: () => void }) => {
      event.stopPropagation?.();
      onCommit(worktree.path);
    },
    [onCommit, worktree.path],
  );
  const expandedState = useMemo(() => ({ expanded }), [expanded]);
  const checkboxState = useMemo(
    () => ({ checked: selected && mergeable, disabled: !mergeable }),
    [mergeable, selected],
  );
  return (
    <View style={styles.worktreeCard}>
      <Pressable
        style={styles.worktreeHeader}
        onPress={handleToggleExpand}
        accessibilityRole="button"
        accessibilityState={expandedState}
        testID={`paseo-deploy-worktree-${worktree.branch}`}
      >
        <Pressable
          onPress={handleToggleSelect}
          disabled={busy || !mergeable}
          hitSlop={8}
          accessibilityRole="checkbox"
          accessibilityState={checkboxState}
          testID={`paseo-deploy-select-${worktree.branch}`}
        >
          <WorktreeCheckbox checked={selected && mergeable} disabled={!mergeable} />
        </Pressable>
        <Text style={styles.worktreeBranch} numberOfLines={1}>
          {describeBranch(worktree.branch)}
        </Text>
        {mergeable && !expanded ? (
          <Text style={styles.worktreeCount}>
            {worktree.ahead > 1 ? `${worktree.ahead} changements` : "1 changement"}
          </Text>
        ) : null}
        {hasUncommitted ? (
          <Button
            variant="secondary"
            size="sm"
            style={styles.worktreeCommitButton}
            textStyle={styles.actionButtonText}
            onPress={handleCommit}
            disabled={busy || committing}
            testID={`paseo-deploy-commit-${worktree.branch}`}
          >
            {committing ? "Enregistrement…" : "Enregistrer"}
          </Button>
        ) : null}
        {expanded ? (
          <ThemedChevronDown size={16} uniProps={chevronColorMapping} />
        ) : (
          <ThemedChevronRight size={16} uniProps={chevronColorMapping} />
        )}
      </Pressable>
      {expanded ? (
        <View style={styles.worktreeDetails}>
          {worktree.commits.map((commit) => (
            <View key={commit.sha} style={styles.itemRow}>
              <Text style={styles.bullet}>•</Text>
              <Text style={styles.itemText}>{humanizeCommitSubject(commit.subject)}</Text>
            </View>
          ))}
          <WorktreeUncommittedHint count={worktree.uncommittedCount} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * "Autres ateliers" — every other Paseo checkout (task-branch worktree) with work
 * not yet on the deploy branch. Tick the ones to include; the merge-and-ship
 * action lives in the sheet's sticky footer so nothing a task did stays invisible.
 */
function WorktreesSection({
  worktrees,
  deselected,
  onToggle,
  onCommit,
  committingPath,
  busy,
}: {
  worktrees: PaseoDeployWorktreeEntry[];
  deselected: Set<string>;
  onToggle: (branch: string) => void;
  onCommit: (path: string) => void;
  committingPath: string | null;
  busy: boolean;
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
            selected={!deselected.has(worktree.branch)}
            onToggle={onToggle}
            onCommit={onCommit}
            committing={committingPath === worktree.path}
            busy={busy}
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
  deselected,
  onToggle,
  onCommit,
  committingPath,
  busy,
}: {
  status: ReturnType<typeof usePaseoDeployStatus>["status"];
  error: string | null;
  deselected: Set<string>;
  onToggle: (branch: string) => void;
  onCommit: (path: string) => void;
  committingPath: string | null;
  busy: boolean;
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
      <DeployPhaseProgress deploying={deploying} phase={status?.deployPhase} />
      <WorktreesSummary worktrees={worktrees} />

      <PendingFilesSection files={uncommittedFiles} />
      <PendingCommitsSection commits={unshippedCommits} />
      <WorktreesSection
        worktrees={worktrees}
        deselected={deselected}
        onToggle={onToggle}
        onCommit={onCommit}
        committingPath={committingPath}
        busy={busy}
      />

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
  const [error, setError] = useState<string | null>(null);
  // Worktree path whose "Enregistrer" (commit) action is currently running.
  const [committingPath, setCommittingPath] = useState<string | null>(null);
  // True during the brief window between clicking "Déployer" and the daemon
  // reporting `deploying: true` on the next status poll.
  const [triggering, setTriggering] = useState(false);

  const sheetHeader = useMemo<SheetHeader>(() => ({ title: "À déployer" }), []);

  const deploying = status?.deploying ?? false;
  const worktrees = status?.worktrees ?? EMPTY_WORKTREES;
  const unshippedCommits = status?.unshippedCommits ?? EMPTY_COMMITS;

  // Selection of ateliers to merge-and-ship. Track UNchecked branches, so freshly-
  // appearing ateliers default to selected and the set survives status polling.
  const [deselected, setDeselected] = useState<Set<string>>(() => new Set());
  const toggle = useCallback((branch: string) => {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (next.has(branch)) next.delete(branch);
      else next.add(branch);
      return next;
    });
  }, []);
  // The ticked, shippable ateliers (source of both the branch list and the count).
  const selectedWorktrees = useMemo(
    () => worktrees.filter((worktree) => worktree.ahead > 0 && !deselected.has(worktree.branch)),
    [worktrees, deselected],
  );
  const selectedBranches = useMemo(
    () => selectedWorktrees.map((worktree) => worktree.branch),
    [selectedWorktrees],
  );

  // The single "Déployer" action: trigger the daemon's LOCAL build directly —
  // no agent in the middle. The daemon merges the ticked branches into the
  // deploy checkout, then runs the local build+publish script; the sheet stays
  // open and polls the status so the user watches "Construction → Publication →
  // En ligne" live via `deployPhase`.
  const handleDeploy = useCallback(async () => {
    if (!client || triggering || deploying) return;
    const trunkPending = unshippedCommits.length > 0;
    if (selectedWorktrees.length === 0 && !trunkPending) return;
    setError(null);
    setTriggering(true);
    try {
      const result = await client.paseoDeployTrigger({ mergeBranches: selectedBranches });
      if (!result.started) {
        setError(result.error ?? "Le déploiement n'a pas pu démarrer.");
        return;
      }
      // Kick an immediate status refresh so `deploying`/`deployPhase` appear
      // without waiting for the next poll tick.
      onDeployed();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Échec du déploiement.");
    } finally {
      setTriggering(false);
    }
  }, [
    client,
    triggering,
    deploying,
    selectedWorktrees,
    selectedBranches,
    unshippedCommits.length,
    onDeployed,
  ]);

  // Save (commit) an atelier's pending work so its card becomes selectable —
  // then refresh the status so the "unsaved files" hint disappears at once.
  const handleCommitWorktree = useCallback(
    async (path: string) => {
      if (!client || committingPath) return;
      setError(null);
      setCommittingPath(path);
      try {
        const result = await client.paseoDeployCommitWorktree({ worktreePath: path });
        if (!result.committed && result.error) {
          setError(result.error);
        }
        onDeployed();
      } catch (err) {
        setError(err instanceof Error && err.message ? err.message : "Échec de l'enregistrement.");
      } finally {
        setCommittingPath(null);
      }
    },
    [client, committingPath, onDeployed],
  );

  // Something to deploy = at least one ticked atelier, or changes already ready
  // on the deploy trunk. No project needed anymore — the daemon builds directly.
  const hasTrunkPending = unshippedCommits.length > 0;
  const inProgress = deploying || triggering;
  const canDeploy = (selectedBranches.length > 0 || hasTrunkPending) && !inProgress;
  const selectionCount = selectedBranches.length;
  // Lock the atelier cards (checkboxes + "Enregistrer") while a build is running
  // or the trigger request is in flight.
  const busy = inProgress;

  // A single sticky footer action. "Déployer" triggers the local build directly;
  // while it runs, the label follows the phase (Construction → Publication → OK).
  const deployLabel = inProgress
    ? deployPhaseLabel(status?.deployPhase, triggering)
    : `Déployer${selectionCount > 0 ? ` (${selectionCount})` : ""}`;
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button
          variant="default"
          size="sm"
          style={styles.actionButton}
          textStyle={styles.actionButtonText}
          onPress={handleDeploy}
          disabled={!canDeploy}
          testID="paseo-deploy-confirm"
        >
          {deployLabel}
        </Button>
      </View>
    ),
    [handleDeploy, canDeploy, deployLabel],
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
        deselected={deselected}
        onToggle={toggle}
        onCommit={handleCommitWorktree}
        committingPath={committingPath}
        busy={busy}
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
  // Matches the app-wide sheet section-title convention (settings.ts): small,
  // regular weight, muted — so every drawer reads the same.
  sectionTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
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
  progress: {
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  progressHeader: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  progressTitle: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.foreground,
  },
  progressPercent: {
    fontSize: theme.fontSize.xs,
    fontWeight: "700",
    color: theme.colors.foregroundMuted,
  },
  progressTrack: {
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.primary,
  },
  progressSteps: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[1],
  },
  progressStep: {
    flex: 1,
    alignItems: "center",
    gap: theme.spacing[1],
  },
  progressDot: {
    width: theme.spacing[4],
    height: theme.spacing[4],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  progressDotDone: {
    backgroundColor: theme.colors.palette.green[400],
    borderColor: theme.colors.palette.green[400],
  },
  progressDotActive: {
    borderColor: theme.colors.primary,
  },
  progressStepLabel: {
    fontSize: Math.round(theme.fontSize.xs * 0.92),
    textAlign: "center",
    color: theme.colors.foregroundMuted,
  },
  progressStepLabelActive: {
    fontWeight: "700",
    color: theme.colors.foreground,
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
  worktreeHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  worktreeDetails: {
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[6],
  },
  // Compact "Enregistrer" action pinned to the right of the atelier's header row.
  worktreeCommitButton: {
    paddingHorizontal: theme.spacing[2],
  },
  worktreeBranch: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: "700",
    color: theme.colors.foreground,
  },
  worktreeCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  checkbox: {
    width: theme.spacing[4],
    height: theme.spacing[4],
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  checkboxDisabled: {
    opacity: 0.4,
  },
  // One-line spread across ateliers, under the main tally.
  worktreesSummary: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
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

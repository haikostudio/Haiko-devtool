import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type {
  PaseoDeployPendingCommit,
  PaseoDeployPendingFile,
  PaseoDeployWorktree,
} from "@getpaseo/protocol/messages";
import { runGitCommand } from "./run-git-command.js";

/** Personal self-host fork feature — these paths are hardcoded for this host. */
const REPO_ROOT = "/root/paseo";
/**
 * Local build + publish script. Replaces the old GitHub-Actions round-trip
 * (`paseo-ship-now.sh` dispatched `build-web-selfhost.yml`, waited for CI, then
 * downloaded the artifact): the server now builds the static site itself and
 * copies it straight into the Caddy webroot. No commit/CI required to publish —
 * git is kept for backup only. ~3-5 min on the KVM4 host.
 *
 * Now version-controlled at `ops/paseo-build-local.sh` (so the running script
 * always tracks the repo). It builds from a frozen git-worktree snapshot of the
 * commit being published, isolating the build from parallel edits in the shared
 * `/root/paseo` checkout. The legacy `/home/paseo/paseo-build-local.sh` path is
 * kept as a thin wrapper that execs this one, so older daemons still work.
 */
const SHIP_SCRIPT = `${REPO_ROOT}/ops/paseo-build-local.sh`;
const DEPLOYED_SHA_FILE = "/var/www/paseo-app/.deployed-sha";
/**
 * Version the SERVED site declares — the same file the app polls to offer
 * "Nouvelle version — Recharger". Read alongside the deploy marker so a
 * publication that copied only half of itself is caught instead of trusted.
 */
const SERVED_VERSION_FILE = "/var/www/paseo-app/version.json";
const SHIP_LOG_FILE = "/home/paseo/paseo-ship-now.log";
/**
 * Coarse progress phase written by the local build script at each step
 * (`save` → `build` → `publish` → `done`, or `error`). Read while a deploy is
 * running so the button can show "Construction → Publication → En ligne".
 */
const PHASE_FILE = "/home/paseo/paseo-build-local.phase";
/**
 * Anti-double-run lock the build script holds with `flock -n 9` while it runs.
 * A crashed build leaves the FILE on disk but not the kernel lock, so the file
 * alone is never a real blocker — but the "Réinitialiser" action still removes a
 * provably-unheld one so nothing stale is left behind. Only removed when a
 * `flock -n` probe confirms no live process holds it (see
 * {@link clearResidualDeployLock}); a genuinely-held lock is left untouched.
 */
const DEPLOY_LOCK_FILE = "/home/paseo/paseo-build-local.lock";
/**
 * Commit the running daemon's COMPILED code was built from, written by
 * `ops/paseo-build-local.sh` when it installs a fresh `dist`.
 *
 * The daemon executes `packages/*\/dist`, not the source, so "which commit was
 * HEAD when I booted" is not the same question as "which commit am I running".
 * Publication used to build the web app only: a server-side fix could be
 * committed, published and followed by a restart while the daemon reloaded the
 * exact same old compiled code — the fix looked deployed and did nothing. This
 * marker is what makes the difference observable.
 */
const DAEMON_BUILD_MARKER = "/home/paseo/paseo-daemon-built.sha";
/**
 * How long a finished run's outcome stays visible in the status after it ends.
 * Without this the progress block vanished the instant the build stopped, so a
 * publish that went live — or one that failed — left no trace at all and the
 * sheet snapped back to "N changements à publier". That is the "j'ai cliqué et
 * il ne s'est rien passé" report.
 */
const DEPLOY_OUTCOME_RETENTION_MS = 15 * 60 * 1000;
/**
 * Safety valve for a run whose child process died without ever firing `exit`
 * (daemon suspended, OOM-killed script, …). Without it `deploying` stayed true
 * forever and the Déployer button was permanently disabled — a stuck spinner
 * with no way out but a daemon restart.
 */
const DEPLOY_MAX_RUNTIME_MS = 30 * 60 * 1000;
/** Bytes of the ship log read to recover a human-readable failure reason. */
const SHIP_LOG_TAIL_BYTES = 32 * 1024;

/**
 * Repo paths whose changes only take effect once the daemon is restarted —
 * everything compiled into the running daemon process. Pure client/web changes
 * (packages/app, docs, …) reach users through a web deploy instead, so they must
 * NOT trigger the "restart the engine" hint.
 */
export const DAEMON_CODE_PATHS = [
  "packages/server",
  "packages/protocol",
  "packages/cli",
  "packages/relay",
  "packages/highlight",
];

/** Outcome of a finished run — what the sheet reports once the build stops. */
export type PaseoDeployOutcome = "success" | "failed";

/**
 * The deploy run this process knows about. Kept after it finishes (with
 * `finishedAt` and `outcome` set) so the sheet can show "En ligne ✅" or the
 * failure reason instead of the progress block disappearing. A daemon restart
 * clears it, which is also what stops a crashed build from leaving a spinner
 * that never resolves.
 */
interface DeployRun {
  startedAt: number;
  finishedAt: number | null;
  outcome: PaseoDeployOutcome | null;
  /**
   * Last phase observed for THIS run. Never inherited from an earlier run: the
   * phase file is reset before the script starts, and stale files are ignored
   * by mtime, because reading a previous run's `done` made the sheet jump to
   * "En ligne ✅ 100 %" one second after the click.
   */
  phase: string | null;
  /** `--no-build` runs save without publishing — no "live" claim to make. */
  noBuild: boolean;
  /** Agent carrying out this publication, when one was launched for it. */
  agentId: string | null;
  /**
   * The changes this run is putting online, captured at the click. Kept after
   * the run ends because a successful publish empties the "not yet online" list:
   * without this snapshot the sheet would simply lose the changes instead of
   * showing them go green, which reads as "they vanished".
   */
  commits: PaseoDeployPendingCommit[];
}
let currentRun: DeployRun | null = null;
/** Error from the last finished deploy run, if it failed. */
let lastError: string | null = null;

function isDeployRunning(): boolean {
  return currentRun !== null && currentRun.finishedAt === null;
}

/** Details of a publish that just went live. */
export interface PaseoDeploySuccess {
  /** Task branches merged into the deploy branch for this ship (may be empty). */
  mergedBranches: string[];
}

/**
 * Fired once a full publish (build + deploy) finishes successfully. Wired at
 * bootstrap to promote the shipped tasks' cards into the "deployed" column.
 * `--no-build` runs (commit-only, nothing goes live) never fire it.
 */
let onDeploySuccess: ((event: PaseoDeploySuccess) => void) | null = null;

export function setPaseoDeploySuccessListener(
  listener: ((event: PaseoDeploySuccess) => void) | null,
): void {
  onDeploySuccess = listener;
}

/** Everything the deploy agent needs to know about the run it is carrying out. */
export interface PaseoDeployAgentLaunchInput {
  /** Deploy checkout to work in. */
  repoRoot: string;
  /** Build + publish script the agent must run (never reinvent it). */
  shipScript: string;
  /** File the script appends its output to. */
  logFile: string;
  /** File the script writes its coarse phase to. */
  phaseFile: string;
  /** Task branches merged into the deploy branch just before this run. */
  mergedBranches: string[];
}

export interface PaseoDeployAgentRun {
  agentId: string;
  /** Resolves with the agent's closing words once its run ends. */
  done: Promise<string | null>;
}

/**
 * Launches the agent that carries out a publication. Registered at bootstrap
 * (the deploy module must not depend on the agent stack). When none is
 * registered — tests, or a `--no-build` save — the build script is spawned
 * directly instead.
 */
export type PaseoDeployAgentLauncher = (
  input: PaseoDeployAgentLaunchInput,
) => Promise<PaseoDeployAgentRun>;

let launchDeployAgent: PaseoDeployAgentLauncher | null = null;

export function setPaseoDeployAgentLauncher(launcher: PaseoDeployAgentLauncher | null): void {
  launchDeployAgent = launcher;
}
/**
 * HEAD at the moment the daemon booted — captured once so we can tell, later,
 * that new daemon-side commits have landed since this process started (they stay
 * dormant until a restart). Must be recorded at startup, before HEAD can move.
 */
let daemonBootSha: string | null = null;

/** Commit the running daemon's compiled code came from, read once at startup. */
let daemonBuiltSha: string | null = null;

/**
 * Record the commit the daemon is running. Call once from bootstrap at startup,
 * before any git work advances HEAD, so the "engine is behind" hint is honest.
 *
 * Two facts, not one: HEAD at boot, and the commit the compiled `dist` was built
 * from. They differ exactly when a publication shipped source the daemon never
 * compiled — the silent failure this pair exists to expose.
 */
export async function recordDaemonBootSha(): Promise<void> {
  try {
    const result = await runGitCommand(["rev-parse", "HEAD"], { cwd: REPO_ROOT });
    daemonBootSha = result.stdout.trim() || null;
  } catch {
    daemonBootSha = null;
  }
  daemonBuiltSha = await readDaemonBuildSha();
}

/** The marker written by the publish script, or null when it was never written. */
async function readDaemonBuildSha(): Promise<string | null> {
  try {
    const raw = await readFile(DAEMON_BUILD_MARKER, "utf8");
    return raw.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The commit whose code the daemon is ACTUALLY executing: the compiled marker
 * when there is one, the boot HEAD otherwise (older installs, dev runs from
 * source). Everything that answers "is the engine behind?" must start here — the
 * boot HEAD alone silently assumes the build was up to date.
 */
function getDaemonRunningSha(): string | null {
  return daemonBuiltSha ?? daemonBootSha;
}

/**
 * Count commits since the daemon's code was compiled that touch daemon-side code
 * — the real number of shipped-but-dormant features waiting for a restart.
 * Returns 0 when the running SHA is unknown or equals HEAD.
 */
async function getDaemonBehindCount(headSha: string | null): Promise<number> {
  const runningSha = getDaemonRunningSha();
  if (runningSha === null || runningSha === headSha) {
    return 0;
  }
  try {
    const result = await runGitCommand(
      ["log", "--format=%h", `${runningSha}..HEAD`, "--", ...DAEMON_CODE_PATHS],
      { cwd: REPO_ROOT },
    );
    return result.stdout.split("\n").filter((line) => line.length > 0).length;
  } catch {
    // Range failed (e.g. boot SHA unknown to git after a rebase) — no honest count.
    return 0;
  }
}

/** What the freshness check found about the compiled daemon. */
export interface DaemonBuildFreshness {
  /** Commit the compiled daemon came from; null when no marker was ever written. */
  builtSha: string | null;
  /** Commit that is published (live), read from the deployed marker. */
  deployedSha: string | null;
  /**
   * Version the SERVED site actually carries (`version.json`, the file the app
   * itself polls to offer "Nouvelle version — Recharger"). Null when unreadable.
   */
  servedSha: string | null;
  /**
   * True when the daemon runs code OLDER than what is published — the exact
   * "published, restarted, still the old behaviour" trap. Never true without
   * both markers: an unknown answer must not raise an alarm.
   */
  stale: boolean;
  /**
   * True when the SITE and its own deploy marker disagree — a publication that
   * copied the bundle but left the marker behind (or the reverse). Same rule:
   * never true on a missing file.
   */
  siteMismatch: boolean;
}

/** The version the served site declares, from the webroot's `version.json`. */
async function readServedSha(): Promise<string | null> {
  try {
    const raw = await readFile(SERVED_VERSION_FILE, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && "sha" in parsed) {
      const sha = (parsed as { sha?: unknown }).sha;
      return typeof sha === "string" && sha.trim().length > 0 ? sha.trim() : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** The version currently published (the site's own marker), or null if unknown. */
export async function getPublishedSha(): Promise<string | null> {
  return await readDeployedSha();
}

/**
 * Compare the compiled daemon against what is published. Called right after a
 * boot (a publication restarts the daemon as its very last step), so it answers
 * "did the publication I just did actually reach the engine?".
 */
export async function getDaemonBuildFreshness(): Promise<DaemonBuildFreshness> {
  const [builtSha, deployedSha, servedSha] = await Promise.all([
    readDaemonBuildSha(),
    readDeployedSha(),
    readServedSha(),
  ]);
  return {
    builtSha,
    deployedSha,
    servedSha,
    stale: builtSha !== null && deployedSha !== null && builtSha !== deployedSha,
    siteMismatch: servedSha !== null && deployedSha !== null && servedSha !== deployedSha,
  };
}

/** What the running daemon is missing: how many daemon-side commits, at which HEAD. */
export interface DaemonRestartDebt {
  commitCount: number;
  headSha: string | null;
}

/**
 * The daemon's restart debt right now: daemon-side commits landed since it
 * booted. `commitCount === 0` means the running process IS the current code —
 * nothing to restart for. Used by the restart reminder; deliberately cheap (two
 * git reads) so it can be polled.
 */
export async function getDaemonRestartDebt(): Promise<DaemonRestartDebt> {
  try {
    const head = await runGitCommand(["rev-parse", "HEAD"], { cwd: REPO_ROOT });
    const headSha = head.stdout.trim() || null;
    return { commitCount: await getDaemonBehindCount(headSha), headSha };
  } catch {
    // No git, no honest answer — and an unknown debt must never nag.
    return { commitCount: 0, headSha: null };
  }
}

export interface PaseoDeployStatus {
  deploying: boolean;
  /**
   * Coarse phase of a running local build (`save` | `build` | `publish` |
   * `done` | `error`), or null when idle/unknown. Drives the button's
   * "Construction → Publication → En ligne" progress.
   */
  deployPhase: string | null;
  /** Epoch ms the running (or last finished) run started; null before any run. */
  deployStartedAt: number | null;
  /** Epoch ms the last run ended; null while one is still running. */
  deployFinishedAt: number | null;
  /**
   * How the last finished run ended. Explicit rather than derived from the
   * phase: a script killed mid-build leaves the phase at `build`, which must
   * still read as a failure and not as "still working".
   */
  deployOutcome: PaseoDeployOutcome | null;
  /** Agent carrying out the running (or last finished) publication, if any. */
  deployAgentId: string | null;
  hasPending: boolean;
  uncommittedFiles: PaseoDeployPendingFile[];
  unshippedCommits: PaseoDeployPendingCommit[];
  /**
   * Every change of the current publication cycle, each with its own status and
   * the files it touches. Superset of {@link unshippedCommits}: it keeps the
   * changes that just went live so the list turns green instead of emptying.
   */
  changes: PaseoDeployPendingCommit[];
  /**
   * Real number of distinct files that differ from what's currently live —
   * committed-but-unshipped, uncommitted, and new files all counted once. This
   * stays honest when work gets grouped into a few commits (a 60-file change is
   * still "60 changes", not "3 commits").
   */
  changesCount: number;
  headSha: string | null;
  deployedSha: string | null;
  /** Commit the running daemon booted from (null if unknown). */
  daemonSha: string | null;
  /**
   * Commit the running daemon's COMPILED code was built from. Differs from
   * {@link PaseoDeployStatus.daemonSha} when a publication shipped source that
   * was never compiled into the engine — a restart would change nothing there.
   */
  daemonBuiltSha: string | null;
  /** Daemon-side commits landed since boot, dormant until a restart. */
  daemonBehindCount: number;
  branch: string | null;
  /**
   * Other Paseo checkouts (task-branch worktrees) with work not yet on the
   * deploy branch — each mergeable-and-shippable from the modal.
   */
  worktrees: PaseoDeployWorktree[];
  lastError: string | null;
  error: string | null;
}

export interface PaseoDeployTriggerResult {
  started: boolean;
  error: string | null;
  /**
   * The agent launched to carry out this publication, when one was (a real
   * build handed to a supervising agent). Null for save-only or direct-spawn
   * runs. Lets the batch record point the progress banner at the live agent.
   */
  agentId?: string | null;
}

/** Tag used for tasks opened automatically when a selected branch conflicts. */
export const PASEO_DEPLOY_CONFLICT_TAG = "paseo:deploy-conflict";
export const PASEO_DEPLOY_BRANCH_TAG_PREFIX = "paseo:deploy-branch:";
/** Branches created internally to repair a deploy conflict are never deploy inputs. */
export const PASEO_DEPLOY_REPAIR_BRANCH_PREFIX = "task/reparer-le-conflit-avant-publication-";

export function isPaseoDeployRepairBranch(branch: string): boolean {
  return branch.startsWith(PASEO_DEPLOY_REPAIR_BRANCH_PREFIX);
}

export interface PaseoDeployConflictTaskInput {
  projectId: string;
  branch: string;
  worktreePath: string | null;
  reason: string;
}

let createConflictTask: ((input: PaseoDeployConflictTaskInput) => Promise<void>) | null = null;

/** Wire the task board after bootstrap has created it. */
export function setPaseoDeployConflictTaskCreator(
  creator: ((input: PaseoDeployConflictTaskInput) => Promise<void>) | null,
): void {
  createConflictTask = creator;
}

export interface PaseoDeployCommitWorktreeResult {
  committed: boolean;
  error: string | null;
}

async function queueConflictTask(input: {
  projectId: string | undefined;
  branch: string;
  reason: string;
}): Promise<boolean> {
  if (!input.projectId || !createConflictTask) {
    return false;
  }
  const worktrees = await listWorktrees();
  const worktree = worktrees.find((entry) => entry.branch === input.branch);
  await createConflictTask({
    projectId: input.projectId,
    branch: input.branch,
    worktreePath: worktree?.path ?? null,
    reason: input.reason,
  });
  return true;
}

async function prepareDeployBranches(input: {
  projectId: string | undefined;
  branches: string[];
}): Promise<{ branchesToMerge: string[]; queuedBranches: string[] }> {
  if (input.branches.length === 0) {
    return { branchesToMerge: [], queuedBranches: [] };
  }
  const [worktrees, deployHead] = await Promise.all([
    listWorktrees(),
    runGitCommand(["rev-parse", "HEAD"], { cwd: REPO_ROOT })
      .then((result) => result.stdout.trim())
      .catch(() => null),
  ]);
  const branchesToMerge: string[] = [];
  const queuedBranches: string[] = [];
  for (const branch of input.branches) {
    // A repair task gets its own temporary worktree. It must never appear as a
    // new deploy candidate, otherwise the UI can ask for a repair of the repair.
    if (isPaseoDeployRepairBranch(branch)) {
      continue;
    }
    const worktree = worktrees.find((entry) => entry.branch === branch);
    const uncommittedCount = worktree ? await getWorktreeUncommittedCount(worktree.path) : 0;
    const mergeCheck = worktree
      ? await checkBranchMerge(deployHead, worktree.head)
      : { mergeable: false, mergeReason: "unknown" as const };
    if (worktree && uncommittedCount === 0 && mergeCheck.mergeable) {
      branchesToMerge.push(branch);
      continue;
    }
    let reason = "La branche n'a pas pu être vérifiée.";
    if (uncommittedCount > 0) {
      reason = "Des fichiers ne sont pas encore enregistrés.";
    } else if (mergeCheck.mergeReason === "conflict") {
      reason = "La branche entre en conflit avec l'application actuelle.";
    }
    const queued = await queueConflictTask({ projectId: input.projectId, branch, reason });
    if (queued) {
      queuedBranches.push(branch);
    } else {
      branchesToMerge.push(branch);
    }
  }
  return { branchesToMerge, queuedBranches };
}

async function readDeployedSha(): Promise<string | null> {
  try {
    const raw = await readFile(DEPLOYED_SHA_FILE, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Coarse phase of `run`, read from {@link PHASE_FILE}. A file older than the
 * run is ignored: the script writes its first phase a moment after spawning, and
 * reading the *previous* run's value in that window is what made the sheet flash
 * a finished state (or an old `error`) right after the user clicked Déployer.
 */
async function readDeployPhase(run: DeployRun): Promise<string | null> {
  try {
    const [info, raw] = await Promise.all([stat(PHASE_FILE), readFile(PHASE_FILE, "utf8")]);
    // 2s of slack: the reset write and the run's own start timestamp are taken
    // a few milliseconds apart, and file mtimes have coarser resolution.
    if (info.mtimeMs + 2_000 < run.startedAt) {
      return null;
    }
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Clear the phase marker before a run starts, so the first status poll cannot
 * pick up the previous run's phase. Best effort — {@link readDeployPhase} also
 * guards on mtime.
 */
async function resetDeployPhase(): Promise<void> {
  try {
    await writeFile(PHASE_FILE, "start\n", "utf8");
  } catch {
    // Best effort — the mtime guard still keeps a stale phase out.
  }
}

/**
 * Tail of the ship log. Read bounded from the end because the log is appended to
 * on every deploy and grows without limit.
 */
async function readShipLogTail(): Promise<string> {
  const handle = await open(SHIP_LOG_FILE, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(SHIP_LOG_TAIL_BYTES, size);
    if (length === 0) {
      return "";
    }
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Why the last build refused to publish, in the script's own words. The build
 * script prints every fatal reason as `!! <raison>` before giving up, so the last
 * such line is the honest cause — infinitely more useful than "code 1", which
 * was all the sheet could say before (and it did not even show that).
 */
export function extractShipFailureReason(logTail: string): string | null {
  const lines = logTail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith("!! ")) {
      return line.slice(3).trim() || null;
    }
  }
  return null;
}

/** Store the failure reason for the sheet, once the log has been consulted. */
async function recordShipFailure(exitCode: number | null): Promise<void> {
  lastError = await describeShipFailure(exitCode);
}

async function describeShipFailure(exitCode: number | null): Promise<string> {
  try {
    const reason = extractShipFailureReason(await readShipLogTail());
    if (reason !== null) {
      return reason;
    }
  } catch {
    // Log unreadable — fall back to the exit code below.
  }
  return `Le déploiement s'est arrêté sans finir (code ${exitCode ?? "inconnu"}).`;
}

/**
 * Resolve the current run's live state for a status poll: apply the runtime
 * safety valve, refresh the phase, and drop a finished run once its outcome has
 * been on screen long enough.
 */
async function resolveDeployRun(now: number): Promise<DeployRun | null> {
  const run = currentRun;
  if (run === null) {
    return null;
  }
  if (run.finishedAt === null) {
    run.phase = await readDeployPhase(run);
    if (now - run.startedAt > DEPLOY_MAX_RUNTIME_MS) {
      // The runtime valve fired — but the run may well have finished its work
      // and only failed to report. The served marker is the truth: if HEAD is
      // already live, this is a success that lost its exit signal, not a stall.
      if (await isPublicationLive()) {
        run.finishedAt = now;
        run.outcome = "success";
        run.phase = "done";
        lastError = null;
      } else {
        run.finishedAt = now;
        run.outcome = "failed";
        lastError = "Le déploiement a dépassé 30 minutes sans se terminer.";
      }
    }
    return run;
  }
  if (now - run.finishedAt > DEPLOY_OUTCOME_RETENTION_MS) {
    currentRun = null;
    return null;
  }
  return run;
}

/**
 * Remove the build lock file when — and only when — a `flock -n` probe proves no
 * live process holds it. `flock -n <file> true` exits 0 when the lock is free
 * (and releases it immediately), non-zero when a build genuinely holds it. So a
 * 0 exit means the on-disk file is a leftover from a crashed run and is safe to
 * delete; anything else means a real publication is in flight and we leave it be.
 * Best effort throughout — a lock we cannot probe or remove is not fatal, since
 * a fresh build re-acquires the flock regardless.
 */
async function clearResidualDeployLock(): Promise<void> {
  const free = await new Promise<boolean>((resolve) => {
    try {
      const probe = spawn("flock", ["-n", DEPLOY_LOCK_FILE, "true"], { stdio: "ignore" });
      probe.on("exit", (code) => resolve(code === 0));
      probe.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
  if (!free) {
    return;
  }
  try {
    await unlink(DEPLOY_LOCK_FILE);
  } catch {
    // Already gone or unremovable — nothing left to clean.
  }
}

/**
 * "Réinitialiser / Relancer le déploiement": wipe every trace of a stuck or
 * failed publication so a fresh attempt starts from a clean slate. Force-clears
 * the in-memory run and its error (a ghost run whose child died without firing
 * `exit` would otherwise keep the button disabled), resets the phase marker, and
 * removes a provably-unheld residual lock. The user stays the one who triggers
 * the new run — this only unblocks the path.
 */
export async function resetPaseoDeployState(): Promise<void> {
  currentRun = null;
  lastError = null;
  await Promise.all([resetDeployPhase(), clearResidualDeployLock()]);
}

function parseUncommittedFiles(porcelain: string): PaseoDeployPendingFile[] {
  return porcelain
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3),
    }));
}

/** Where one change stands in the publication pipeline. */
export type PaseoDeployCommitState = NonNullable<PaseoDeployPendingCommit["state"]>;

export interface AnnotateDeployCommitsInput {
  /** Changes that are committed but not live yet, as git sees it right now. */
  unshipped: PaseoDeployPendingCommit[];
  /** The changes the current/last run took on, or null when no run is known. */
  runCommits: PaseoDeployPendingCommit[] | null;
  running: boolean;
  outcome: PaseoDeployOutcome | null;
}

/**
 * Give every change its own status, so the sheet can say where each one stands
 * instead of showing a single global figure.
 *
 * The subtle part is the successful run: git then reports NOTHING unshipped, so
 * the list would go empty at the exact moment the reader wants confirmation.
 * The run's own snapshot is replayed as "deployed" and put first, and anything
 * committed since (git's list) follows as "pending" — which is the truth: it
 * landed after the publication started and is not online.
 *
 * Pure, so the state machine is unit-tested without git.
 */
function withCommitState(
  commit: PaseoDeployPendingCommit,
  state: PaseoDeployCommitState,
): PaseoDeployPendingCommit {
  return { sha: commit.sha, subject: commit.subject, state, files: commit.files };
}

export function annotateDeployCommits(
  input: AnnotateDeployCommitsInput,
): PaseoDeployPendingCommit[] {
  if (input.running) {
    // A publication takes the whole trunk with it — including the work its own
    // save step commits on the way. So everything still on the ground is on its
    // way up, and marking part of it "waiting" would be a lie.
    return input.unshipped.map((commit) => withCommitState(commit, "deploying"));
  }
  const runCommits = input.runCommits ?? [];
  if (runCommits.length === 0) {
    return input.unshipped.map((commit) => withCommitState(commit, "pending"));
  }
  if (input.outcome === "success") {
    const published = new Set(runCommits.map((commit) => commit.sha));
    return [
      ...runCommits.map((commit) => withCommitState(commit, "deployed")),
      // Committed after the publication started: genuinely still on the ground.
      ...input.unshipped
        .filter((commit) => !published.has(commit.sha))
        .map((commit) => withCommitState(commit, "pending")),
    ];
  }
  // The run failed: nothing went online, and saying so on every line is the
  // whole point — an empty-looking list after a failure is what makes people
  // think the mechanism silently swallowed their work.
  return input.unshipped.map((commit) => withCommitState(commit, "failed"));
}

/** Cap on per-change file detail: enough for a real publication, bounded cost. */
const COMMIT_FILE_DETAIL_LIMIT = 25;

/**
 * Files touched by a change, for the expandable detail under each line. Only
 * the first {@link COMMIT_FILE_DETAIL_LIMIT} changes are detailed — one git call
 * each, and a hundred-commit backlog is not worth a hundred subprocesses.
 */
async function attachCommitFiles(
  commits: PaseoDeployPendingCommit[],
): Promise<PaseoDeployPendingCommit[]> {
  return Promise.all(
    commits.map(async (commit, index) => {
      if (index >= COMMIT_FILE_DETAIL_LIMIT || commit.sha.length === 0) {
        return commit;
      }
      try {
        const result = await runGitCommand(
          ["show", "--name-only", "--format=", "--no-renames", commit.sha],
          { cwd: REPO_ROOT, maxOutputBytes: 64 * 1024 },
        );
        const files = result.stdout.split("\n").filter((line) => line.trim().length > 0);
        return files.length > 0 ? { ...commit, files } : commit;
      } catch {
        // A change whose files can't be listed still shows its line and status.
        return commit;
      }
    }),
  );
}

async function getUnshippedCommits(
  deployedSha: string | null,
  headSha: string | null,
): Promise<PaseoDeployPendingCommit[]> {
  if (deployedSha === null || deployedSha === headSha) {
    return [];
  }
  try {
    const result = await runGitCommand(["log", "--format=%h%x1f%s", `${deployedSha}..HEAD`], {
      cwd: REPO_ROOT,
    });
    return result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha, subject] = line.split("\x1f");
        return { sha: sha ?? "", subject: subject ?? "" };
      });
  } catch {
    // Range failed (e.g. deployedSha unknown to git) — treat as nothing unshipped.
    return [];
  }
}

/**
 * Distinct files that differ from the deployed baseline — the real volume of
 * pending work. `git diff --name-only <deployedSha>` already merges
 * committed-but-unshipped edits with uncommitted ones (deduplicated); we add
 * untracked new files on top. This is what stops the "60 changes → 3 commits"
 * shrinkage once work gets committed.
 *
 * Returns null when the baseline can't be used (unknown sha, git failure), so a
 * caller can tell "nothing pending" apart from "cannot tell".
 */
async function collectChangedFiles(deployedSha: string | null): Promise<string[] | null> {
  if (deployedSha === null) {
    return null;
  }
  try {
    const [tracked, untracked] = await Promise.all([
      runGitCommand(["diff", "--name-only", deployedSha], { cwd: REPO_ROOT }),
      runGitCommand(["ls-files", "--others", "--exclude-standard"], { cwd: REPO_ROOT }),
    ]);
    const files = new Set<string>();
    for (const line of tracked.stdout.split("\n")) {
      if (line.length > 0) files.add(line);
    }
    for (const line of untracked.stdout.split("\n")) {
      if (line.length > 0) files.add(line);
    }
    return [...files];
  } catch {
    return null;
  }
}

/**
 * The files the next publication will carry, for callers that need to reason
 * about WHAT is pending rather than how much (e.g. "does shipping this need a
 * daemon restart?"). Null when the answer can't be established.
 */
export async function getPendingDeployFiles(): Promise<string[] | null> {
  return collectChangedFiles(await readDeployedSha());
}

async function getChangedFileCount(
  deployedSha: string | null,
  uncommittedFiles: PaseoDeployPendingFile[],
): Promise<number> {
  const files = await collectChangedFiles(deployedSha);
  // Without a usable deployed baseline we can only trust the working-tree status.
  return files === null ? uncommittedFiles.length : files.length;
}

interface GitWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  /**
   * Git reported this registration as stale (`prunable <reason>`) — the working
   * directory is gone but `git worktree prune` has not run yet. Such an entry
   * must never reach the deploy list: its SHA still resolves, so every readiness
   * check answers "conflict"/"unknown" and the modal shows a ghost atelier that
   * can never be repaired.
   */
  prunable: boolean;
}

/**
 * Parse `git worktree list --porcelain` into structured entries. Detached
 * worktrees (no branch) come back with `branch: null` and are skipped by
 * callers that need a mergeable branch name.
 */
export function parseWorktreeList(porcelain: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = {
        path: line.slice("worktree ".length),
        branch: null,
        head: null,
        prunable: false,
      };
    } else if ((line === "prunable" || line.startsWith("prunable ")) && current) {
      current.prunable = true;
    } else if (line.startsWith("HEAD ") && current) {
      current.head = line.slice("HEAD ".length).trim() || null;
    } else if (line.startsWith("branch ") && current) {
      // "branch refs/heads/foo" -> "foo"
      current.branch =
        line
          .slice("branch ".length)
          .replace(/^refs\/heads\//, "")
          .trim() || null;
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

async function listWorktrees(): Promise<GitWorktree[]> {
  try {
    const result = await runGitCommand(["worktree", "list", "--porcelain"], { cwd: REPO_ROOT });
    return parseWorktreeList(result.stdout);
  } catch {
    return [];
  }
}

/**
 * Latest known Paseo checkout roots. Cached so `server_info` (built
 * synchronously) can read it without a git call; refreshed whenever the deploy
 * status is polled and primed once at bootstrap.
 */
let cachedDeployRoots: string[] = [REPO_ROOT];

/**
 * Absolute paths of every Paseo checkout — the main repo plus its worktrees.
 * The client uses this to decide where the deploy button may appear, so a
 * task-branch worktree shows it too, not just `/root/paseo`. Falls back to just
 * the main root if worktree discovery fails. Side effect: updates the cache read
 * by {@link getCachedPaseoDeployRoots}.
 */
export async function getPaseoDeployRoots(): Promise<string[]> {
  const worktrees = await listWorktrees();
  const roots = new Set<string>([REPO_ROOT]);
  for (const wt of worktrees) {
    if (wt.path.length > 0) roots.add(wt.path);
  }
  cachedDeployRoots = [...roots];
  return cachedDeployRoots;
}

/**
 * Synchronous snapshot of the Paseo checkout roots for `server_info`. Returns
 * the last value computed by {@link getPaseoDeployRoots} (primed at bootstrap,
 * refreshed on every status poll).
 */
export function getCachedPaseoDeployRoots(): string[] {
  return cachedDeployRoots;
}

/**
 * True when a project's checkout is the Paseo self-host repo (main root or one
 * of its worktrees). Finishing a card on that project publishes it — there is no
 * deploy button any more, the card's completion IS the publish.
 */
export function isPaseoDeployRoot(rootPath: string | null | undefined): boolean {
  if (!rootPath) {
    return false;
  }
  return rootPath === REPO_ROOT || cachedDeployRoots.includes(rootPath);
}

/**
 * Count uncommitted files in a worktree (shown as an info count only — those
 * changes must be committed in their own atelier before they can ship).
 */
async function getWorktreeUncommittedCount(path: string): Promise<number> {
  try {
    const result = await runGitCommand(["status", "--porcelain"], { cwd: path });
    return result.stdout.split("\n").filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

/**
 * Commits on `branch` that are not yet on the deploy branch (`deployHeadSha`) —
 * i.e. exactly what a "fusionner puis publier" would add. Capped for display.
 */
async function getBranchAheadCommits(
  deployHeadSha: string | null,
  branchHead: string | null,
): Promise<PaseoDeployPendingCommit[]> {
  if (deployHeadSha === null || branchHead === null || deployHeadSha === branchHead) {
    return [];
  }
  try {
    const result = await runGitCommand(
      ["log", "--format=%h%x1f%s", "-n", "50", `${deployHeadSha}..${branchHead}`],
      { cwd: REPO_ROOT },
    );
    return result.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const [sha, subject] = line.split("\x1f");
        return { sha: sha ?? "", subject: subject ?? "" };
      });
  } catch {
    return [];
  }
}

/** Exact history size for display; the commit preview above is intentionally capped. */
async function getBranchCommitCount(
  deployHeadSha: string | null,
  branchHead: string | null,
): Promise<number> {
  if (deployHeadSha === null || branchHead === null || deployHeadSha === branchHead) {
    return 0;
  }
  try {
    const result = await runGitCommand(["rev-list", "--count", `${deployHeadSha}..${branchHead}`], {
      cwd: REPO_ROOT,
    });
    return Number.parseInt(result.stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Does `refs/heads/<branch>` still resolve? A branch that was merged and then
 * deleted (archive flow) can outlive its ref inside a stale worktree
 * registration. Merging it later fails with "Branche introuvable", so it is
 * filtered out of the deploy list instead of being offered as pending work.
 */
async function branchRefExists(branch: string): Promise<boolean> {
  try {
    await runGitCommand(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: REPO_ROOT,
    });
    return true;
  } catch {
    return false;
  }
}

interface BranchMergeCheck {
  mergeable: boolean;
  mergeReason: "ready" | "conflict" | "unknown";
}

/**
 * Check a branch without touching the checkout. This is the same three-way
 * merge Git would attempt later, but it leaves no half-merged files behind.
 */
async function checkBranchMerge(
  deployHeadSha: string | null,
  branchHead: string | null,
): Promise<BranchMergeCheck> {
  if (deployHeadSha === null || branchHead === null || deployHeadSha === branchHead) {
    return { mergeable: false, mergeReason: "unknown" };
  }
  try {
    const result = await runGitCommand(["merge-tree", "--write-tree", deployHeadSha, branchHead], {
      cwd: REPO_ROOT,
      acceptExitCodes: [0, 1],
      maxOutputBytes: 64 * 1024,
    });
    return result.exitCode === 0
      ? { mergeable: true, mergeReason: "ready" }
      : { mergeable: false, mergeReason: "conflict" };
  } catch {
    return { mergeable: false, mergeReason: "unknown" };
  }
}

/**
 * Every OTHER Paseo checkout (task-branch worktree) that carries work not yet on
 * the deploy branch — committed commits ahead and/or uncommitted files. The
 * deploy checkout itself is excluded (its own pending work is the top-level
 * status). This is what lets the modal regroup all ateliers in one view.
 */
async function getPendingWorktrees(
  worktrees: GitWorktree[],
  deployHeadSha: string | null,
): Promise<PaseoDeployWorktree[]> {
  const results = await Promise.all(
    worktrees
      .filter(
        (wt) =>
          wt.path !== REPO_ROOT &&
          wt.branch !== null &&
          !wt.prunable &&
          !isPaseoDeployRepairBranch(wt.branch),
      )
      .map(async (wt): Promise<PaseoDeployWorktree | null> => {
        const branch = wt.branch as string;
        // A deleted branch cannot be merged, so it is not pending work — drop it
        // before the readiness checks turn it into an unrepairable "conflict".
        if (!(await branchRefExists(branch))) {
          return null;
        }
        const [commits, commitCount, uncommittedCount, mergeCheck] = await Promise.all([
          getBranchAheadCommits(deployHeadSha, wt.head),
          getBranchCommitCount(deployHeadSha, wt.head),
          getWorktreeUncommittedCount(wt.path),
          checkBranchMerge(deployHeadSha, wt.head),
        ]);
        if (commits.length === 0 && uncommittedCount === 0) {
          return null;
        }
        return {
          path: wt.path,
          branch,
          ahead: commitCount,
          commitCount,
          commits,
          uncommittedCount,
          mergeable: mergeCheck.mergeable,
          mergeReason: mergeCheck.mergeReason,
        };
      }),
  );
  return results.filter((entry): entry is PaseoDeployWorktree => entry !== null);
}

/** The five run-derived status fields, in one place for both status branches. */
interface DeployRunFields {
  deploying: boolean;
  deployPhase: string | null;
  deployStartedAt: number | null;
  deployFinishedAt: number | null;
  deployOutcome: PaseoDeployOutcome | null;
  deployAgentId: string | null;
}

function describeDeployRun(run: DeployRun | null): DeployRunFields {
  return {
    deploying: run !== null && run.finishedAt === null,
    deployPhase: run?.phase ?? null,
    deployStartedAt: run?.startedAt ?? null,
    deployFinishedAt: run?.finishedAt ?? null,
    deployOutcome: run?.outcome ?? null,
    deployAgentId: run?.agentId ?? null,
  };
}

/** Cheap view of the running/last publication — no git calls, safe to poll. */
export interface PaseoDeployRunSnapshot {
  deploying: boolean;
  phase: string | null;
  outcome: PaseoDeployOutcome | null;
  error: string | null;
}

/**
 * Light-weight publication progress, for the narration posted into a task's
 * conversation. {@link getPaseoDeployStatus} answers the same question but runs
 * a dozen git commands to do it, which is far too heavy to poll every few
 * seconds while a build runs.
 */
export async function getPaseoDeployRunSnapshot(): Promise<PaseoDeployRunSnapshot> {
  const run = await resolveDeployRun(Date.now());
  return {
    deploying: run !== null && run.finishedAt === null,
    phase: run?.phase ?? null,
    outcome: run?.outcome ?? null,
    error: lastError,
  };
}

export async function getPaseoDeployStatus(): Promise<PaseoDeployStatus> {
  try {
    const [statusResult, headResult, branchResult, deployedSha] = await Promise.all([
      runGitCommand(["status", "--porcelain"], { cwd: REPO_ROOT }),
      runGitCommand(["rev-parse", "HEAD"], { cwd: REPO_ROOT }),
      runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO_ROOT }),
      readDeployedSha(),
    ]);

    const uncommittedFiles = parseUncommittedFiles(statusResult.stdout);
    const headSha = headResult.stdout.trim() || null;
    const branch = branchResult.stdout.trim() || null;
    const run = await resolveDeployRun(Date.now());

    // Source of truth = `.deployed-sha` vs HEAD, over any log or exit code. When
    // the served marker already matches HEAD the content IS online, so a failed
    // outcome left by a previous run (a build that reported non-zero after the
    // copy landed, or an archiving step that threw AFTER publication) is a false
    // alarm. Self-heal it here — the read path every client polls — so the "À
    // déployer" window never cries "publication échouée" over a live site.
    const publicationLive = deployedSha !== null && deployedSha === headSha;
    if (publicationLive && !isDeployRunning()) {
      if (run !== null && run.finishedAt !== null && run.outcome === "failed") {
        run.outcome = "success";
        run.phase = "done";
      }
      lastError = null;
    }
    const unshippedCommits = await getUnshippedCommits(deployedSha, headSha);
    const changes = await attachCommitFiles(
      annotateDeployCommits({
        unshipped: unshippedCommits,
        runCommits: run?.commits ?? null,
        running: run !== null && run.finishedAt === null,
        outcome: run?.outcome ?? null,
      }),
    );
    const changesCount = await getChangedFileCount(deployedSha, uncommittedFiles);
    const daemonBehindCount = await getDaemonBehindCount(headSha);
    const allWorktrees = await listWorktrees();
    // Keep the roots cache (read synchronously by server_info) fresh on each poll.
    cachedDeployRoots = [
      ...new Set<string>([REPO_ROOT, ...allWorktrees.map((wt) => wt.path).filter(Boolean)]),
    ];
    const worktrees = await getPendingWorktrees(allWorktrees, headSha);

    const hasPending =
      uncommittedFiles.length > 0 ||
      unshippedCommits.length > 0 ||
      worktrees.length > 0 ||
      (deployedSha !== null && deployedSha !== headSha);

    return {
      ...describeDeployRun(run),
      hasPending,
      uncommittedFiles,
      unshippedCommits,
      changes,
      changesCount,
      headSha,
      deployedSha,
      daemonSha: daemonBootSha,
      daemonBuiltSha,
      daemonBehindCount,
      branch,
      worktrees,
      lastError,
      error: null,
    };
  } catch (error) {
    return {
      ...describeDeployRun(currentRun),
      hasPending: false,
      uncommittedFiles: [],
      unshippedCommits: [],
      changes: [],
      changesCount: 0,
      headSha: null,
      deployedSha: null,
      daemonSha: daemonBootSha,
      daemonBuiltSha,
      daemonBehindCount: 0,
      branch: null,
      worktrees: [],
      lastError,
      error: getErrorMessage(error),
    };
  }
}

/**
 * Generated/committed files that diverge between the deploy branch and a task
 * worktree on *every* merge, yet carry no real work to lose. The changelog
 * snapshot is regenerated on each commit from `git log --all` (see the
 * `changelog` job in `lefthook.yml`), so the deploy branch's copy already
 * reflects EVERY branch's entries — keeping our side and letting the next commit
 * regenerate it loses nothing. When a merge conflict touches only these paths we
 * resolve them automatically instead of aborting; any other conflicted path is a
 * real code conflict a human must resolve. Kept in sync with the `merge=ours`
 * rule in the repo-root `.gitattributes`.
 */
export const AUTO_RESOLVABLE_CONFLICT_PATHS = ["packages/app/src/generated/changelog-data.ts"];

export interface MergeConflictClassification {
  autoResolvable: string[];
  manual: string[];
}

/**
 * Split the paths left unmerged after a conflicting merge into the ones we can
 * safely auto-resolve ({@link AUTO_RESOLVABLE_CONFLICT_PATHS}) and the ones that
 * need a human. Pure, so it is unit-tested without touching git.
 */
export function classifyMergeConflicts(unmergedPaths: string[]): MergeConflictClassification {
  const autoResolvable: string[] = [];
  const manual: string[] = [];
  for (const path of unmergedPaths) {
    if (AUTO_RESOLVABLE_CONFLICT_PATHS.includes(path)) {
      autoResolvable.push(path);
    } else {
      manual.push(path);
    }
  }
  return { autoResolvable, manual };
}

/**
 * Register the `ours` merge driver in the deploy checkout so the `.gitattributes`
 * `merge=ours` rule on the generated changelog resolves cleanly (keep our side)
 * during a merge instead of raising a conflict at all. `true` always exits 0, so
 * git keeps the current side. Idempotent — safe to call before every deploy; the
 * post-merge auto-resolver below is the runtime safety net if this ever misses.
 */
async function ensureMergeDriver(): Promise<void> {
  try {
    await runGitCommand(["config", "merge.ours.driver", "true"], { cwd: REPO_ROOT });
  } catch {
    // Best effort — auto-resolution below still handles the conflict.
  }
}

/**
 * A merge just conflicted. If every unmerged path is a regenerated artifact we
 * keep our side (the deploy branch's copy already reflects all branches) and
 * finish the merge; if any real code file conflicts, report it so a human can
 * resolve it in the atelier. The caller aborts the merge when this returns not-ok.
 */
async function tryAutoResolveMergeConflict(
  branch: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let unmerged: string[];
  try {
    const status = await runGitCommand(["diff", "--name-only", "--diff-filter=U"], {
      cwd: REPO_ROOT,
    });
    unmerged = status.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }

  const { autoResolvable, manual } = classifyMergeConflicts(unmerged);

  // A real code conflict — or a blocked merge with no unmerged paths at all —
  // needs a human. Name the offending files so the atelier knows what to fix.
  if (manual.length > 0 || autoResolvable.length === 0) {
    const detail = manual.length > 0 ? ` Fichiers en conflit : ${manual.join(", ")}.` : "";
    return {
      ok: false,
      error: `La fusion de « ${branch} » a échoué (conflit).${detail} Rien n'a été publié ; résous le conflit dans l'atelier puis réessaie.`,
    };
  }

  // Only regenerated artifacts conflict — keep our side and finish the merge.
  try {
    for (const path of autoResolvable) {
      await runGitCommand(["checkout", "--ours", "--", path], { cwd: REPO_ROOT });
      await runGitCommand(["add", "--", path], { cwd: REPO_ROOT });
    }
    // Finish the merge commit without hooks: the changelog hook would just
    // regenerate the file we deliberately kept and could re-conflict.
    const commit = await runGitCommand(["commit", "--no-edit", "--no-verify"], {
      cwd: REPO_ROOT,
      acceptExitCodes: [0, 1],
    });
    if (commit.exitCode !== 0) {
      return { ok: false, error: `La fusion de « ${branch} » a échoué à la finalisation.` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

/**
 * Merge a task branch into the deploy branch inside the main checkout — the
 * "fusionner puis publier" step. Auto-resolves conflicts that only touch
 * regenerated artifacts (changelog snapshot) and finishes the merge; aborts any
 * partial merge cleanly on a real code conflict or an unknown branch, so the
 * deploy branch is never left half-merged. Returns a French error on failure.
 */
async function mergeBranchIntoDeploy(
  branch: string,
): Promise<{ ok: boolean; error: string | null }> {
  // Guard the branch name against anything but a real local branch.
  try {
    const verify = await runGitCommand(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      { cwd: REPO_ROOT, acceptExitCodes: [0, 1] },
    );
    if (verify.exitCode !== 0) {
      return { ok: false, error: `Branche introuvable : ${branch}.` };
    }
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }

  // Already the deploy branch — nothing to merge, ship as-is.
  try {
    const currentBranch = (
      await runGitCommand(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: REPO_ROOT })
    ).stdout.trim();
    if (currentBranch === branch) {
      return { ok: true, error: null };
    }
  } catch {
    // Fall through and let the merge attempt surface any real problem.
  }

  let mergeCheck: BranchMergeCheck;
  try {
    const branchHead = (
      await runGitCommand(["rev-parse", "--verify", `refs/heads/${branch}`], { cwd: REPO_ROOT })
    ).stdout.trim();
    const deployHead = (
      await runGitCommand(["rev-parse", "HEAD"], { cwd: REPO_ROOT })
    ).stdout.trim();
    mergeCheck = await checkBranchMerge(deployHead, branchHead);
  } catch {
    return {
      ok: false,
      error: `La branche « ${branch} » n'a pas pu être vérifiée. Elle n'a pas été publiée.`,
    };
  }
  if (!mergeCheck.mergeable) {
    return {
      ok: false,
      error:
        mergeCheck.mergeReason === "conflict"
          ? `La branche « ${branch} » entre en conflit avec l'application actuelle. Elle n'a pas été publiée.`
          : `La branche « ${branch} » n'a pas pu être vérifiée. Elle n'a pas été publiée.`,
    };
  }

  try {
    const merge = await runGitCommand(["merge", "--no-edit", branch], {
      cwd: REPO_ROOT,
      acceptExitCodes: [0, 1],
    });
    if (merge.exitCode !== 0) {
      // Conflict — try to auto-resolve regenerated artifacts (changelog) and
      // finish the merge; only abort when a real code file conflicts.
      const resolved = await tryAutoResolveMergeConflict(branch);
      if (resolved.ok) {
        return { ok: true, error: null };
      }
      // Abort so the deploy branch stays clean, then surface the conflict.
      await runGitCommand(["merge", "--abort"], {
        cwd: REPO_ROOT,
        acceptExitCodes: [0, 1, 128],
      }).catch(() => {});
      return { ok: false, error: resolved.error };
    }
    return { ok: true, error: null };
  } catch (error) {
    await runGitCommand(["merge", "--abort"], {
      cwd: REPO_ROOT,
      acceptExitCodes: [0, 1, 128],
    }).catch(() => {});
    return { ok: false, error: getErrorMessage(error) };
  }
}

/**
 * Merge every requested branch into the deploy branch, sequentially. Branches
 * that conflict are aborted and skipped (never left half-merged); the ones that
 * merged stay merged. Returns which succeeded and which were skipped so the
 * caller can decide whether to ship and what to report.
 */
async function mergeBranchesIntoDeploy(
  branches: string[],
): Promise<{ merged: string[]; skipped: string[] }> {
  const merged: string[] = [];
  const skipped: string[] = [];
  // Make the `.gitattributes` merge=ours rule active before any merge, so the
  // generated changelog resolves cleanly instead of conflicting.
  await ensureMergeDriver();
  for (const branch of branches) {
    const result = await mergeBranchIntoDeploy(branch);
    if (result.ok) {
      merged.push(branch);
    } else {
      skipped.push(branch);
    }
  }
  return { merged, skipped };
}

/**
 * Enregistrer (commit) tout le travail non enregistré d'un atelier (task-branch
 * worktree) directement depuis la fenêtre « À déployer », pour que sa case
 * devienne cochable. On valide d'abord que le chemin est bien un worktree connu
 * (jamais le checkout de déploiement, jamais un chemin arbitraire venu du fil),
 * puis on `git add -A` + `git commit` (sans les hooks, qui sont lents).
 */
export async function commitWorktreeChanges(input: {
  worktreePath: string;
}): Promise<PaseoDeployCommitWorktreeResult> {
  const worktrees = await listWorktrees();
  const match = worktrees.find(
    (wt) => wt.path === input.worktreePath && wt.path !== REPO_ROOT && wt.branch !== null,
  );
  if (!match) {
    return { committed: false, error: "Atelier introuvable." };
  }
  try {
    const status = await runGitCommand(["status", "--porcelain"], { cwd: match.path });
    if (status.stdout.trim().length === 0) {
      return { committed: false, error: "Rien à enregistrer dans cet atelier." };
    }
    await runGitCommand(["add", "-A"], { cwd: match.path });
    const commit = await runGitCommand(
      ["commit", "--no-verify", "-m", `chore(${match.branch}): enregistrer le travail en cours`],
      { cwd: match.path, acceptExitCodes: [0, 1] },
    );
    if (commit.exitCode !== 0) {
      return { committed: false, error: "L'enregistrement a échoué." };
    }
    return { committed: true, error: null };
  } catch (error) {
    return { committed: false, error: getErrorMessage(error) };
  }
}

/**
 * Did the publication really reach the live site? Asked of the filesystem, never
 * of the agent: an agent that believes it succeeded is not evidence, whereas the
 * marker the publish step writes next to the served files is. Same rule as the
 * sheet's own "verdict = `.deployed-sha` vs HEAD".
 */
async function isPublicationLive(): Promise<boolean> {
  const [deployedSha, headSha] = await Promise.all([
    readDeployedSha(),
    runGitCommand(["rev-parse", "HEAD"], { cwd: REPO_ROOT })
      .then((result) => result.stdout.trim() || null)
      .catch(() => null),
  ]);
  return deployedSha !== null && headSha !== null && deployedSha === headSha;
}

/** Longest agent explanation kept as a failure reason (it lands in an alert). */
const AGENT_FAILURE_REASON_MAX_LENGTH = 300;

/**
 * Generic last-resort cause, when neither the build log nor the agent's own
 * words carry anything readable.
 */
const GENERIC_FAILURE_REASON =
  "La publication s'est arrêtée sans mettre la nouvelle version en ligne.";

/** Words that make a line read as an actual cause worth surfacing. */
const CAUSE_KEYWORDS =
  /(échou|échec|erreur|conflit|redémarr|construction|build|impossible|introuvable|disque|plein|full|interromp|timeout|refus|cassé|manqu)/i;

/**
 * Lines an agent writes that are NOT the failure cause and must never end up in
 * the red banner: the imposed header (model / level / time / cost), and the
 * running-commentary an agent leaves while it works ("le moniteur est en place,
 * je serai notifié…"). Before this filter the banner showed "Codex très haut,
 * 12 min, coût…" as the reason — the header, not the error.
 */
const NOISE_LINE =
  /(\bchf\b|coût|tarif|\bopus\b|\bcodex\b|\bsonnet\b|\bhaiku\b|\bgpt\b|niveau\s|moniteur|je serai notifié|notifié dès|j'attends|suivi est en place|je surveille|je vous préviens|en place, je)/i;

/** Strip markdown noise (headings, bold, list markers) from a candidate line. */
function stripMarkdown(line: string): string {
  return line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .trim();
}

/**
 * The readable cause hidden in an agent's closing message: drop the header and
 * the progress chatter, then prefer the last line that actually names a failure,
 * falling back to the last meaningful line. Returns null when nothing survives,
 * so the caller can reach for a generic sentence rather than echoing noise.
 *
 * Exported for the same reason as extractShipFailureReason: this is pure text
 * triage and deserves its own tests, independent of the filesystem.
 */
export function sanitizeAgentFailureReason(summary: string | null): string | null {
  const candidates = (summary ?? "")
    .split("\n")
    .map(stripMarkdown)
    .filter((line) => line.length > 0 && !NOISE_LINE.test(line));
  if (candidates.length === 0) {
    return null;
  }
  const cause =
    candidates.toReversed().find((line) => CAUSE_KEYWORDS.test(line)) ??
    candidates[candidates.length - 1];
  if (!cause) {
    return null;
  }
  return cause.length > AGENT_FAILURE_REASON_MAX_LENGTH
    ? `${cause.slice(0, AGENT_FAILURE_REASON_MAX_LENGTH)}…`
    : cause;
}

/**
 * Why nothing went live, in the most concrete words available: the build
 * script's own fatal line first, then the agent's closing words (stripped of the
 * header and progress chatter), then a generic sentence. Never silence — a
 * publication that stops without a reason is exactly the "j'ai cliqué et il ne
 * s'est rien passé" report.
 */
async function describeAgentFailure(summary: string | null): Promise<string> {
  try {
    const reason = extractShipFailureReason(await readShipLogTail());
    if (reason !== null) {
      return reason;
    }
  } catch {
    // Log unreadable — fall back to what the agent said.
  }
  return sanitizeAgentFailureReason(summary) ?? GENERIC_FAILURE_REASON;
}

/** Close a run carried out by an agent, on the evidence rather than its word. */
async function finishAgentRun(
  run: DeployRun,
  input: { summary: string | null; mergedBranches: string[] },
): Promise<void> {
  // A superseded or already-closed run must not clobber a newer one.
  if (currentRun !== run || run.finishedAt !== null) {
    return;
  }
  const live = await isPublicationLive();
  if (currentRun !== run || run.finishedAt !== null) {
    return;
  }
  run.finishedAt = Date.now();
  if (!live) {
    run.outcome = "failed";
    run.phase = "error";
    lastError = await describeAgentFailure(input.summary);
    return;
  }
  run.outcome = "success";
  run.phase = "done";
  if (onDeploySuccess) {
    try {
      onDeploySuccess({ mergedBranches: input.mergedBranches });
    } catch {
      // A listener failure must never break the deploy flow.
    }
  }
}

export async function triggerPaseoDeploy(input: {
  noBuild?: boolean;
  projectId?: string;
  mergeBranches?: string[];
  /**
   * "Réinitialiser / Relancer": wipe a stuck or falsely-failed run's state (and a
   * residual lock) before starting, so the user can escape a jammed publication
   * without a daemon restart. The user still initiates the new run — this only
   * clears the way for it.
   */
  reset?: boolean;
}): Promise<PaseoDeployTriggerResult> {
  if (input.reset) {
    await resetPaseoDeployState();
  }
  if (isDeployRunning()) {
    return { started: false, error: "Un déploiement est déjà en cours." };
  }

  // Inspect selected ateliers before touching the deploy checkout. A conflict
  // is work for an agent, not a reason to disable the user's checkbox or make
  // the whole publication fail silently.
  let skippedNote: string | null = null;
  let mergedBranches: string[] = [];
  const prepared = await prepareDeployBranches({
    projectId: input.projectId,
    branches: input.mergeBranches ?? [],
  });
  const queuedBranches = prepared.queuedBranches;
  const branchesToMerge = prepared.branchesToMerge;
  if (branchesToMerge.length > 0) {
    const { merged, skipped } = await mergeBranchesIntoDeploy(branchesToMerge);
    mergedBranches = merged;
    for (const branch of skipped) {
      const queued = await queueConflictTask({
        projectId: input.projectId,
        branch,
        reason: "La fusion a rencontré un conflit pendant la publication.",
      });
      if (queued) queuedBranches.push(branch);
    }
    if (merged.length === 0) {
      const error =
        queuedBranches.length > 0
          ? `Les conflits ont été confiés à un agent : ${queuedBranches.join(", ")}.`
          : `La fusion a échoué : ${skipped.join(", ")}.`;
      lastError = error;
      return { started: false, error };
    }
    if (skipped.length > 0) {
      skippedNote = `Conflits confiés à un agent : ${skipped.join(", ")}.`;
    }
  }
  if (queuedBranches.length > 0 && mergedBranches.length === 0 && !input.noBuild) {
    lastError = `Réparation automatique en cours : ${queuedBranches.join(", ")}.`;
    return { started: false, error: lastError };
  }

  try {
    // Clear the previous run's phase BEFORE starting, so the first status poll
    // cannot report a finished/failed state that belongs to an earlier build.
    await resetDeployPhase();
    // Snapshot what this publication is taking online, AFTER the merges and
    // BEFORE the build. This is the list the sheet follows change by change.
    const [deployedShaAtStart, headShaAtStart] = await Promise.all([
      readDeployedSha(),
      runGitCommand(["rev-parse", "HEAD"], { cwd: REPO_ROOT })
        .then((result) => result.stdout.trim() || null)
        .catch(() => null),
    ]);
    const run: DeployRun = {
      startedAt: Date.now(),
      finishedAt: null,
      outcome: null,
      phase: null,
      noBuild: input.noBuild === true,
      agentId: null,
      commits: await getUnshippedCommits(deployedShaAtStart, headShaAtStart),
    };
    currentRun = run;
    // Keep the skip note visible after a partial merge; otherwise clear.
    lastError = skippedNote;

    // A real publication is handed to an agent: it runs the build script, keeps
    // an eye on it, and — unlike a bare `spawn` — can actually deal with what
    // goes wrong (a stale dependency, a full disk, a half-finished copy) instead
    // of leaving a dead progress bar behind. A save-only run stays a plain
    // script call: there is nothing to supervise.
    if (!run.noBuild && launchDeployAgent !== null) {
      const launched = await launchDeployAgent({
        repoRoot: REPO_ROOT,
        shipScript: SHIP_SCRIPT,
        logFile: SHIP_LOG_FILE,
        phaseFile: PHASE_FILE,
        mergedBranches,
      });
      run.agentId = launched.agentId;
      void launched.done.then(
        (summary) => finishAgentRun(run, { summary, mergedBranches }),
        (error) => finishAgentRun(run, { summary: getErrorMessage(error), mergedBranches }),
      );
      return { started: true, error: null, agentId: launched.agentId };
    }

    const logFd = openSync(SHIP_LOG_FILE, "a");
    const child = spawn(SHIP_SCRIPT, input.noBuild ? ["--no-build"] : [], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });

    child.on("exit", (code) => {
      void (async () => {
        // Guard against a late exit from a superseded run clobbering a newer one.
        if (currentRun !== run || run.finishedAt !== null) {
          return;
        }
        // A non-zero exit is not proof of failure: the served marker is. If HEAD
        // is already live the publish landed and the exit code is noise — mark it
        // a success rather than a false "publication échouée".
        if (code !== 0 && !(await isPublicationLive())) {
          if (currentRun !== run || run.finishedAt !== null) {
            return;
          }
          run.finishedAt = Date.now();
          run.outcome = "failed";
          run.phase = "error";
          await recordShipFailure(code);
          return;
        }
        if (currentRun !== run || run.finishedAt !== null) {
          return;
        }
        run.finishedAt = Date.now();
        run.outcome = "success";
        run.phase = "done";
        // Full publish succeeded: let listeners (task board) react to what
        // shipped. A --no-build run commits without publishing, so nothing went
        // live — skip. A listener throw (e.g. a card archiving step that fails)
        // is swallowed here on purpose: the publication already succeeded, so an
        // archiving miss must NEVER turn a live site into a failed outcome.
        if (!input.noBuild && onDeploySuccess) {
          try {
            onDeploySuccess({ mergedBranches });
          } catch {
            // A listener failure must never break the deploy flow.
          }
        }
      })();
    });
    child.on("error", (err) => {
      if (currentRun !== run || run.finishedAt !== null) {
        return;
      }
      run.finishedAt = Date.now();
      run.outcome = "failed";
      run.phase = "error";
      lastError = err.message;
    });

    child.unref();
    return { started: true, error: null };
  } catch (error) {
    currentRun = null;
    return { started: false, error: getErrorMessage(error) };
  }
}

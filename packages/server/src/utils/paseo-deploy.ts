import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
 */
const SHIP_SCRIPT = "/home/paseo/paseo-build-local.sh";
const DEPLOYED_SHA_FILE = "/var/www/paseo-app/.deployed-sha";
const SHIP_LOG_FILE = "/home/paseo/paseo-ship-now.log";
/**
 * Coarse progress phase written by the local build script at each step
 * (`save` → `build` → `publish` → `done`, or `error`). Read while a deploy is
 * running so the button can show "Construction → Publication → En ligne".
 */
const PHASE_FILE = "/home/paseo/paseo-build-local.phase";

/**
 * Repo paths whose changes only take effect once the daemon is restarted —
 * everything compiled into the running daemon process. Pure client/web changes
 * (packages/app, docs, …) reach users through a web deploy instead, so they must
 * NOT trigger the "restart the engine" hint.
 */
const DAEMON_CODE_PATHS = [
  "packages/server",
  "packages/protocol",
  "packages/cli",
  "packages/relay",
  "packages/highlight",
];

/** A ship (commit/push/build/deploy) is currently running. */
let deploying = false;
/** Error from the last finished deploy run, if it failed. */
let lastError: string | null = null;

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
/**
 * HEAD at the moment the daemon booted — captured once so we can tell, later,
 * that new daemon-side commits have landed since this process started (they stay
 * dormant until a restart). Must be recorded at startup, before HEAD can move.
 */
let daemonBootSha: string | null = null;

/**
 * Record the commit the daemon is running. Call once from bootstrap at startup,
 * before any git work advances HEAD, so the "engine is behind" hint is honest.
 */
export async function recordDaemonBootSha(): Promise<void> {
  try {
    const result = await runGitCommand(["rev-parse", "HEAD"], { cwd: REPO_ROOT });
    daemonBootSha = result.stdout.trim() || null;
  } catch {
    daemonBootSha = null;
  }
}

/**
 * Count commits since the daemon booted that touch daemon-side code — the real
 * number of shipped-but-dormant features waiting for a restart. Returns 0 when
 * the boot SHA is unknown or equals HEAD.
 */
async function getDaemonBehindCount(headSha: string | null): Promise<number> {
  if (daemonBootSha === null || daemonBootSha === headSha) {
    return 0;
  }
  try {
    const result = await runGitCommand(
      ["log", "--format=%h", `${daemonBootSha}..HEAD`, "--", ...DAEMON_CODE_PATHS],
      { cwd: REPO_ROOT },
    );
    return result.stdout.split("\n").filter((line) => line.length > 0).length;
  } catch {
    // Range failed (e.g. boot SHA unknown to git after a rebase) — no honest count.
    return 0;
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
  hasPending: boolean;
  uncommittedFiles: PaseoDeployPendingFile[];
  unshippedCommits: PaseoDeployPendingCommit[];
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
 * Current coarse phase of a running local build, read from {@link PHASE_FILE}.
 * Only meaningful while `deploying` is true; returns null when unknown so the
 * client just shows a generic "in progress" state.
 */
async function readDeployPhase(): Promise<string | null> {
  try {
    const raw = await readFile(PHASE_FILE, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
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
 * Count distinct files that differ from the deployed baseline — the real volume
 * of pending work. `git diff --name-only <deployedSha>` already merges
 * committed-but-unshipped edits with uncommitted ones (deduplicated); we add
 * untracked new files on top. This is what stops the "60 changes → 3 commits"
 * shrinkage once work gets committed.
 */
async function getChangedFileCount(
  deployedSha: string | null,
  uncommittedFiles: PaseoDeployPendingFile[],
): Promise<number> {
  // Without a known deployed baseline we can only trust the working-tree status.
  if (deployedSha === null) {
    return uncommittedFiles.length;
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
    return files.size;
  } catch {
    // Range failed (e.g. deployedSha unknown to git) — fall back to the working tree.
    return uncommittedFiles.length;
  }
}

interface GitWorktree {
  path: string;
  branch: string | null;
  head: string | null;
}

/**
 * Parse `git worktree list --porcelain` into structured entries. Detached
 * worktrees (no branch) come back with `branch: null` and are skipped by
 * callers that need a mergeable branch name.
 */
function parseWorktreeList(porcelain: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | null = null;
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: line.slice("worktree ".length), branch: null, head: null };
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
          wt.path !== REPO_ROOT && wt.branch !== null && !isPaseoDeployRepairBranch(wt.branch),
      )
      .map(async (wt): Promise<PaseoDeployWorktree | null> => {
        const branch = wt.branch as string;
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
    // Only surface a phase while a build is actually running; a stale file from a
    // finished run must not read as "still building".
    const deployPhase = deploying ? await readDeployPhase() : null;
    const unshippedCommits = await getUnshippedCommits(deployedSha, headSha);
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
      deploying,
      deployPhase,
      hasPending,
      uncommittedFiles,
      unshippedCommits,
      changesCount,
      headSha,
      deployedSha,
      daemonSha: daemonBootSha,
      daemonBehindCount,
      branch,
      worktrees,
      lastError,
      error: null,
    };
  } catch (error) {
    return {
      deploying,
      deployPhase: null,
      hasPending: false,
      uncommittedFiles: [],
      unshippedCommits: [],
      changesCount: 0,
      headSha: null,
      deployedSha: null,
      daemonSha: daemonBootSha,
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

export async function triggerPaseoDeploy(input: {
  noBuild?: boolean;
  projectId?: string;
  mergeBranches?: string[];
}): Promise<PaseoDeployTriggerResult> {
  if (deploying) {
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
    deploying = true;
    // Keep the skip note visible after a partial merge; otherwise clear.
    lastError = skippedNote;

    const logFd = openSync(SHIP_LOG_FILE, "a");
    const child = spawn(SHIP_SCRIPT, input.noBuild ? ["--no-build"] : [], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });

    child.on("exit", (code) => {
      deploying = false;
      if (code !== 0) {
        lastError = `Le déploiement a échoué (code ${code}). Voir ${SHIP_LOG_FILE}`;
        return;
      }
      // Full publish succeeded: let listeners (task board) react to what shipped.
      // A --no-build run commits without publishing, so nothing went live — skip.
      if (!input.noBuild && onDeploySuccess) {
        try {
          onDeploySuccess({ mergedBranches });
        } catch {
          // A listener failure must never break the deploy flow.
        }
      }
    });
    child.on("error", (err) => {
      deploying = false;
      lastError = err.message;
    });

    child.unref();
    return { started: true, error: null };
  } catch (error) {
    deploying = false;
    return { started: false, error: getErrorMessage(error) };
  }
}

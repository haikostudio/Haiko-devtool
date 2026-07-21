import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { PaseoDeployPendingCommit, PaseoDeployPendingFile } from "@getpaseo/protocol/messages";
import { runGitCommand } from "./run-git-command.js";

/** Personal self-host fork feature — these paths are hardcoded for this host. */
const REPO_ROOT = "/root/paseo";
const SHIP_SCRIPT = "/home/paseo/paseo-ship-now.sh";
const DEPLOYED_SHA_FILE = "/var/www/paseo-app/.deployed-sha";
const SHIP_LOG_FILE = "/home/paseo/paseo-ship-now.log";

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
  lastError: string | null;
  error: string | null;
}

export interface PaseoDeployTriggerResult {
  started: boolean;
  error: string | null;
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
    const unshippedCommits = await getUnshippedCommits(deployedSha, headSha);
    const changesCount = await getChangedFileCount(deployedSha, uncommittedFiles);
    const daemonBehindCount = await getDaemonBehindCount(headSha);

    const hasPending =
      uncommittedFiles.length > 0 ||
      unshippedCommits.length > 0 ||
      (deployedSha !== null && deployedSha !== headSha);

    return {
      deploying,
      hasPending,
      uncommittedFiles,
      unshippedCommits,
      changesCount,
      headSha,
      deployedSha,
      daemonSha: daemonBootSha,
      daemonBehindCount,
      branch,
      lastError,
      error: null,
    };
  } catch (error) {
    return {
      deploying,
      hasPending: false,
      uncommittedFiles: [],
      unshippedCommits: [],
      changesCount: 0,
      headSha: null,
      deployedSha: null,
      daemonSha: daemonBootSha,
      daemonBehindCount: 0,
      branch: null,
      lastError,
      error: getErrorMessage(error),
    };
  }
}

export async function triggerPaseoDeploy(input: {
  noBuild?: boolean;
}): Promise<PaseoDeployTriggerResult> {
  if (deploying) {
    return { started: false, error: "Un déploiement est déjà en cours." };
  }

  try {
    deploying = true;
    lastError = null;

    const logFd = openSync(SHIP_LOG_FILE, "a");
    const child = spawn(SHIP_SCRIPT, input.noBuild ? ["--no-build"] : [], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });

    child.on("exit", (code) => {
      deploying = false;
      if (code !== 0) {
        lastError = `Le déploiement a échoué (code ${code}). Voir ${SHIP_LOG_FILE}`;
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

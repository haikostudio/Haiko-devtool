import type { TaskGit, TaskGitRepo, TaskGitStep } from "@getpaseo/protocol/tasks/types";
import { parseGitHubRemoteUrl } from "@getpaseo/protocol/git-remote";

/**
 * The card's git journey, read from the repository and written on the card.
 *
 * Everything here is a FACT read from git (the branch tip, whether that tip is
 * reachable from a remote) or an outcome reported by whoever performed the step
 * (the deployer, for merge and publication). Nothing is inferred from the column
 * a card sits in: "Terminée" says a human accepted the work, not that the commit
 * exists, was pushed, or was merged — and the gap between those two stories is
 * exactly what this record closes.
 */

export interface CommandOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface TaskGitExec {
  /** Runs `git <args>` in a checkout. Never throws on a non-zero exit. */
  git: (args: string[], cwd: string) => Promise<CommandOutcome>;
}

export interface TaskGitFacts {
  commitSha?: string;
  commitShortSha?: string;
  commitAt?: string;
  commitSubject?: string;
  repo?: TaskGitRepo;
  /**
   * True when the branch tip is reachable from at least one remote branch —
   * either the branch itself was pushed, or it was merged into a branch that
   * was. Null when the answer could not be read (no commit, unreadable repo):
   * an unknown must never be shown as a failure.
   */
  pushed: boolean | null;
}

// Unit separator: safe inside a commit subject, unlike anything printable.
const FIELD_SEP = "\u001f";

/**
 * Reads what git knows about a card's branch: its tip commit and whether that
 * commit already left the machine. Never throws — an unreadable checkout yields
 * empty facts, which the card shows as "en attente" rather than as an error.
 */
export async function readTaskGitFacts(input: {
  exec: TaskGitExec;
  cwd: string;
  branch: string;
}): Promise<TaskGitFacts> {
  const { exec, cwd, branch } = input;
  const facts: TaskGitFacts = { pushed: null };

  const log = await exec.git(
    ["log", "-1", `--format=%H${FIELD_SEP}%h${FIELD_SEP}%cI${FIELD_SEP}%s`, branch, "--"],
    cwd,
  );
  if (log.exitCode === 0) {
    const [sha, shortSha, at, subject] = log.stdout.trim().split(FIELD_SEP);
    if (sha) {
      facts.commitSha = sha;
      if (shortSha) facts.commitShortSha = shortSha;
      if (at) facts.commitAt = at;
      if (subject) facts.commitSubject = subject;
    }
  }

  const repo = await readRepoIdentity(exec, cwd);
  if (repo) {
    facts.repo = repo;
  }

  if (facts.commitSha) {
    // `git branch -r --contains` answers the real question ("did this work leave
    // the machine?") rather than the narrow one ("does refs/remotes/origin/<branch>
    // exist?"): a card whose branch was merged and pushed under another name is
    // just as safely sent, and must not be shown as never pushed.
    const remote = await exec.git(["branch", "-r", "--contains", facts.commitSha], cwd);
    if (remote.exitCode === 0) {
      facts.pushed = remote.stdout.trim().length > 0;
    }
  }

  return facts;
}

/**
 * The repository the checkout points at, when its remote is a forge we can link
 * to. Prefers `origin`, then the first remote that parses — a fork-first setup
 * (`fork` as the push target) still resolves instead of showing nothing.
 */
async function readRepoIdentity(exec: TaskGitExec, cwd: string): Promise<TaskGitRepo | null> {
  const remotes = await exec.git(["remote"], cwd);
  if (remotes.exitCode !== 0) {
    return null;
  }
  const names = remotes.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const ordered = [...names].sort((a, b) => Number(b === "origin") - Number(a === "origin"));
  for (const name of ordered) {
    const url = await exec.git(["remote", "get-url", name], cwd);
    if (url.exitCode !== 0) {
      continue;
    }
    const identity = parseGitHubRemoteUrl(url.stdout.trim());
    if (identity) {
      return {
        forge: "github",
        owner: identity.owner,
        name: identity.name,
        webUrl: `https://github.com/${identity.owner}/${identity.name}`,
      };
    }
  }
  return null;
}

/** Records the dedicated branch. Idempotent: the first stamp keeps its date. */
export function withTaskGitBranch(
  current: TaskGit | null | undefined,
  branch: string,
  now: string,
): TaskGit {
  const base: TaskGit = { ...current };
  if (base.branch === branch) {
    return { ...base, branchAt: base.branchAt ?? now, updatedAt: now };
  }
  return { ...base, branch, branchAt: now, updatedAt: now };
}

/**
 * Folds freshly-read git facts into the card's record.
 *
 * The push step is only ever moved FORWARD by a read: git can prove work left
 * the machine, but "no remote branch contains this commit" a second later is
 * ordinary (a new commit landed on top), and letting that rewrite a success into
 * "en attente" would make the encart flicker between two truths.
 */
export function withTaskGitFacts(
  current: TaskGit | null | undefined,
  facts: TaskGitFacts,
  now: string,
): TaskGit {
  const base: TaskGit = { ...current };
  if (facts.commitSha) {
    base.commitSha = facts.commitSha;
    if (facts.commitShortSha) base.commitShortSha = facts.commitShortSha;
    if (facts.commitAt) base.commitAt = facts.commitAt;
    if (facts.commitSubject) base.commitSubject = facts.commitSubject;
  }
  if (facts.repo) {
    base.repo = facts.repo;
  }
  if (facts.pushed === true && base.push?.state !== "success") {
    base.push = { state: "success", at: now };
  }
  return { ...base, updatedAt: now };
}

/** Sets one step of the journey, keeping everything else untouched. */
export function withTaskGitStep(
  current: TaskGit | null | undefined,
  step: "push" | "merge" | "publish",
  next: TaskGitStep,
  now: string,
): TaskGit {
  return { ...current, [step]: next, updatedAt: now };
}

/** A step outcome, with its date and (on failure) its plain-language reason. */
export function gitStep(
  state: TaskGitStep["state"],
  at: string,
  detail?: string | null,
): TaskGitStep {
  return { state, at, ...(detail ? { detail } : {}) };
}

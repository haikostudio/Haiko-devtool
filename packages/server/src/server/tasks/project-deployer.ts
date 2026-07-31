import type pino from "pino";
import type { DeployRunSnapshot, DeployTriggerResult } from "./batch-deployer.js";

/**
 * The result of running a command: the exit code plus its captured output. A
 * non-zero code is data here, not an exception — the runner branches on it (a
 * `git commit` with nothing to commit exits 1 and must be treated as "skip",
 * not "fail").
 */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProjectDeployExec {
  /** Runs `git <args>` in the project checkout. Never throws on a non-zero exit. */
  git: (args: string[], cwd: string) => Promise<CommandResult>;
  /** Runs an arbitrary command (systemctl, curl, …). Never throws on non-zero. */
  exec: (command: string, args: string[]) => Promise<CommandResult>;
}

/**
 * One card of the lot. Its title becomes a commit message; its branch (when the
 * card ran in an isolated worktree) is merged into main before the build.
 */
export interface ProjectDeployCard {
  title: string;
  branch?: string;
}

export interface ProjectDeployInput {
  rootPath: string;
  /** `autoproject-<slug>` systemd unit + Caddy vhost key for this project. */
  slug: string;
  /** Address the vhost serves, probed once the service is back up. */
  url: string | null;
  cards: ProjectDeployCard[];
}

export interface ProjectDeployerOptions {
  exec: ProjectDeployExec;
  logger: pino.Logger;
}

interface ProjectRunState {
  deploying: boolean;
  phase: string | null;
  outcome: "success" | "failed" | null;
  error: string | null;
  conflictedBranches: string[];
}

const IDLE_STATE: DeployRunSnapshot = {
  deploying: false,
  phase: null,
  outcome: null,
  error: null,
  conflictedBranches: [],
};

/**
 * Central publisher for an ORDINARY project's dev instance on the VPS.
 *
 * Symmetric to Paseo's build script, but for the `autoproject-<slug>` services:
 * instead of every card's own agent deploying its own work — silent, quota-bound,
 * and prone to two agents restarting the same service under each other — ONE
 * actor commits the lot card by card, pushes, restarts the service once, and
 * verifies it is live once. It is a plain process, so a model quota can never
 * block a publication, and the batch deployer watches its phases exactly the way
 * it watches Paseo's.
 *
 * State lives in memory, keyed by checkout path: if the daemon restarts
 * mid-publication the state dies with the process and a fresh daemon starts
 * clean — no stuck ghost run.
 */
export class ProjectDeployer {
  private readonly exec: ProjectDeployExec;
  private readonly logger: pino.Logger;
  private readonly runs = new Map<string, ProjectRunState>();

  constructor(options: ProjectDeployerOptions) {
    this.exec = options.exec;
    this.logger = options.logger.child({ module: "project-deployer" });
  }

  /** The phase snapshot the batch deployer polls while it narrates the run. */
  readRun(rootPath: string): DeployRunSnapshot {
    const state = this.runs.get(rootPath);
    if (!state) {
      return IDLE_STATE;
    }
    return {
      deploying: state.deploying,
      phase: state.phase,
      outcome: state.outcome,
      error: state.error,
      conflictedBranches: [...state.conflictedBranches],
    };
  }

  /**
   * Starts a publication for this project and returns immediately. The build
   * itself runs in the background and reports through {@link readRun}, so the
   * batch deployer can watch it the same way it watches Paseo. A run already
   * active for this checkout is refused rather than raced.
   */
  trigger(input: ProjectDeployInput): DeployTriggerResult {
    const active = this.runs.get(input.rootPath);
    if (active?.deploying) {
      return { started: false, error: "Une publication est déjà en cours pour ce projet." };
    }
    const state: ProjectRunState = {
      deploying: true,
      phase: "merge",
      outcome: null,
      error: null,
      conflictedBranches: [],
    };
    this.runs.set(input.rootPath, state);
    void this.run(input, state);
    return { started: true };
  }

  private async run(input: ProjectDeployInput, state: ProjectRunState): Promise<void> {
    const { rootPath, slug, url, cards } = input;
    const service = `autoproject-${slug}`;
    try {
      // 0. FUSION DES BRANCHES — each isolated card committed its work on its own
      // `task/<id>-<slug>` branch; bring those into main before building. A merge
      // that conflicts with a sibling card is ABORTED (never left half-applied)
      // and its branch recorded: the lot still ships, that card is reported in
      // conflict for a human to resolve. Cards with no branch (in-place) skip this.
      state.phase = "merge";
      const merged: string[] = [];
      for (const card of cards) {
        if (!card.branch) {
          continue;
        }
        const ok = await this.mergeBranch(rootPath, card.branch);
        if (ok) {
          merged.push(card.branch);
        } else {
          state.conflictedBranches.push(card.branch);
        }
      }
      // 1. ENREGISTREMENT PAR CARTE — one commit per card, message = its title.
      // Never one global commit mixing the whole lot: the trace stays reversible
      // card by card. Cards whose work agents already committed as they went (or
      // whose branch was just merged) simply add nothing here (empty → skipped);
      // this step is the safety net that captures any residual uncommitted change.
      state.phase = "prepare";
      for (const card of cards) {
        await this.commitCard(rootPath, card.title);
      }
      // 2. ENVOI — push the lot for backup. Best-effort: the dev instance runs
      // the local checkout, so a push failure (no upstream, offline) must not
      // block a publication that is otherwise sound.
      state.phase = "push";
      const push = await this.exec.git(["push"], rootPath);
      if (push.exitCode !== 0) {
        this.logger.warn(
          { rootPath, stderr: push.stderr.trim() },
          "Project deploy: push failed, continuing (dev instance serves the local checkout)",
        );
      }
      // 3. REDÉMARRAGE — restart the service ONCE so it picks up the new code.
      state.phase = "restart";
      const restart = await this.exec.exec("sudo", ["systemctl", "restart", service]);
      if (restart.exitCode !== 0) {
        throw new Error(
          `Le redémarrage du service ${service} a échoué : ${restart.stderr.trim() || "raison inconnue"}`,
        );
      }
      // 4. VÉRIFICATION — the service is active and the site answers. A restart
      // that left the service dead or the page unreachable is a failed
      // publication, not a success we quietly stamp.
      await this.verify({ service, url });
      // 5. NETTOYAGE — the publication is live, so the merged card branches are
      // now redundant. Delete them best-effort (`git branch -d` only removes a
      // FULLY-merged branch, so a branch still checked out in a worktree or not
      // truly merged is left untouched). Never fails the run — the disk guardrails
      // and worktree lifecycle reclaim the rest.
      for (const branch of merged) {
        const removed = await this.exec.git(["branch", "-d", branch], rootPath);
        if (removed.exitCode !== 0) {
          this.logger.info(
            { rootPath, branch, stderr: removed.stderr.trim() },
            "Project deploy: merged branch not deleted (still checked out or not fully merged)",
          );
        }
      }
      state.phase = "done";
      state.outcome = "success";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.outcome = "failed";
      state.error = message;
      this.logger.warn({ err: error, rootPath }, "Project deploy failed");
    } finally {
      state.deploying = false;
    }
  }

  /**
   * Merges one card's branch into the checkout's current branch. Returns true on
   * a clean merge (including "already up to date"), false on conflict — in which
   * case the merge is ABORTED so the working tree is never left half-merged and
   * the rest of the lot can still proceed. `--no-ff` keeps a visible merge commit
   * per card; `--no-edit` avoids the editor in this non-interactive process.
   */
  private async mergeBranch(rootPath: string, branch: string): Promise<boolean> {
    const merge = await this.exec.git(["merge", "--no-ff", "--no-edit", branch], rootPath);
    if (merge.exitCode === 0) {
      return true;
    }
    this.logger.warn(
      { rootPath, branch, stderr: merge.stderr.trim() || merge.stdout.trim() },
      "Project deploy: branch merge conflicted, aborting it and flagging the card",
    );
    await this.exec.git(["merge", "--abort"], rootPath);
    return false;
  }

  /**
   * Stages everything and commits it under this card's title, unless there is
   * nothing to commit. `git diff --cached --quiet` exits 1 when something is
   * staged, 0 when the index is clean — that is how an empty card is skipped
   * without a failing commit.
   */
  private async commitCard(rootPath: string, title: string): Promise<void> {
    await this.exec.git(["add", "-A"], rootPath);
    const staged = await this.exec.git(["diff", "--cached", "--quiet"], rootPath);
    if (staged.exitCode === 0) {
      this.logger.info({ rootPath, title }, "Project deploy: nothing to commit for card");
      return;
    }
    const commit = await this.exec.git(["commit", "-m", title], rootPath);
    if (commit.exitCode !== 0) {
      throw new Error(
        `L'enregistrement de « ${title} » a échoué : ${commit.stderr.trim() || "raison inconnue"}`,
      );
    }
  }

  /** The service must report active and the URL (when known) must answer 2xx/3xx. */
  private async verify(input: { service: string; url: string | null }): Promise<void> {
    const active = await this.exec.exec("systemctl", ["is-active", input.service]);
    if (active.stdout.trim() !== "active") {
      throw new Error(
        `Le service ${input.service} n'est pas actif après redémarrage (${active.stdout.trim() || "inconnu"}).`,
      );
    }
    if (!input.url) {
      return;
    }
    const probe = await this.exec.exec("curl", [
      "-sS",
      "-o",
      "/dev/null",
      "-w",
      "%{http_code}",
      "-I",
      "--max-time",
      "15",
      input.url,
    ]);
    const code = Number.parseInt(probe.stdout.trim(), 10);
    if (!Number.isFinite(code) || code < 200 || code >= 400) {
      throw new Error(
        `Le site ${input.url} ne répond pas correctement après redémarrage (code ${probe.stdout.trim() || "aucun"}).`,
      );
    }
  }
}

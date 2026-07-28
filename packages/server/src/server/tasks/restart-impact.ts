import type { KanbanTask } from "@getpaseo/protocol/tasks/types";
import {
  DAEMON_CODE_PATHS,
  getPendingDeployFiles,
  isPaseoDeployRoot,
} from "../../utils/paseo-deploy.js";

/**
 * Paths whose code is loaded by the RUNNING daemon process — a change under one
 * of these only takes effect once the daemon is restarted; publishing the web
 * app is not enough.
 *
 * Deliberately the SAME list the "engine is behind" counter uses
 * ({@link DAEMON_CODE_PATHS}): the pre-publication warning and the
 * post-publication debt must never disagree about what counts as daemon code.
 * It covers `server`, `protocol`, `relay`, `highlight` (all compiled into the
 * daemon) and `cli` — the daemon is launched through the CLI entry point, so its
 * code is the daemon's too. `packages/app`, `packages/website` and the desktop
 * wrapper are absent: they reach users through a publish, not a restart.
 */
const DAEMON_RESTART_PREFIXES = DAEMON_CODE_PATHS.map((path) => `${path}/`);

/**
 * Files that live under a daemon package but change nothing the daemon runs:
 * tests are never loaded by the daemon, and prose is prose. Without this a
 * server-side test tweak would ask the user for a pointless restart.
 */
function isInertFile(file: string): boolean {
  return (
    file.endsWith(".md") ||
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx") ||
    file.includes("/__tests__/")
  );
}

/**
 * Does this set of changed files require a daemon restart to take effect?
 *
 * Pure, so the rule is unit-tested without touching git. The answer is
 * deliberately conservative in one direction only: any single daemon-side file
 * is enough to say yes, because an unannounced restart requirement is the
 * failure the user actually feels ("I published and nothing changed").
 */
export function needsDaemonRestartForFiles(files: readonly string[]): boolean {
  return files.some(
    (file) =>
      !isInertFile(file) && DAEMON_RESTART_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );
}

/**
 * Whether publishing this project's pending work will require a daemon restart.
 *
 * Only Paseo's own checkout can ever require one — the daemon is Paseo's, so a
 * client project's work never touches it. For a Paseo root the answer is read
 * from the files that are pending publication (everything the next publication
 * will carry: committed-but-unshipped edits plus the working tree), which is
 * exactly the set the restart question is about.
 *
 * Returns `null` when the answer cannot be established (git unavailable, no
 * deployed baseline): callers must then leave the card's existing flag alone
 * rather than overwrite it with a guess.
 */
export async function resolveDaemonRestartImpact(
  projectRoot: string | null,
): Promise<boolean | null> {
  if (projectRoot === null) {
    return null;
  }
  if (!isPaseoDeployRoot(projectRoot)) {
    // A client project's work cannot make the Paseo daemon stale.
    return false;
  }
  const files = await getPendingDeployFiles();
  if (files === null) {
    return null;
  }
  return needsDaemonRestartForFiles(files);
}

/**
 * Clears the restart debt of cards whose work is already live, because a daemon
 * that has just booted IS running the current code — every published card was
 * waiting on exactly this.
 *
 * Without it the flag would be permanent: nothing ever cleared it, so a shipped
 * card kept offering "Redémarrer le moteur" forever and its "Archiver" bar (which
 * shares that one slot) could never be reached again.
 *
 * Deliberately limited to cards that are LIVE. A card still waiting to be
 * published keeps its flag: that one is a forecast about the next publication,
 * which this boot says nothing about. "Live" is the deploy stamp, NEVER the
 * column — "À déployer" is the queue a finished card waits in, so reading the
 * column here would wipe the forecast of every card still waiting to go out.
 *
 * Pure, so the rule is unit-tested without a store, a clock or git.
 */
export function settleDeployedRestartFlags<T extends KanbanTask>(tasks: T[]): T[] {
  let changed = false;
  const settled = tasks.map((task) => {
    const isLive =
      task.deployedAt != null || task.deployedUrl != null || task.deployment?.state === "deployed";
    if (!isLive || task.needsDaemonRestart !== true) {
      return task;
    }
    changed = true;
    return { ...task, needsDaemonRestart: false };
  });
  return changed ? settled : tasks;
}

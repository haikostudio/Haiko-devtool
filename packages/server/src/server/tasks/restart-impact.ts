import { getPendingDeployFiles, isPaseoDeployRoot } from "../../utils/paseo-deploy.js";

/**
 * Paths whose code is loaded by the RUNNING daemon process. A change under one
 * of these only takes effect once the daemon is restarted — publishing the web
 * app is not enough.
 *
 * `protocol`, `relay` and `highlight` are compiled INTO the daemon bundle, so a
 * change there is as much a daemon change as `server` itself. Deliberately
 * absent: `packages/app` and `packages/website` (a rebuild/publish is all they
 * need), `packages/cli` and `packages/desktop` (separate processes the user
 * relaunches on their own, never the daemon).
 */
export const DAEMON_RESTART_PREFIXES = [
  "packages/server/",
  "packages/protocol/",
  "packages/relay/",
  "packages/highlight/",
] as const;

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

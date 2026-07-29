import { useEffect, useState } from "react";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

/**
 * How often the engine's version is re-checked. It can only change when a
 * publication restarts the daemon, so a slow poll is plenty — this is a safety
 * net, not a live gauge.
 */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

export interface DaemonBuildFreshness {
  /** Version the running engine was built from. */
  builtSha: string;
  /** Version that is published (what the site serves). */
  deployedSha: string;
}

/**
 * Watches whether the engine actually runs the published version.
 *
 * The daemon executes compiled code, not source: a publication that shipped the
 * site without rebuilding the engine leaves a daemon running an older build, and
 * everything looks fine — the commit is there, the site is up, and the fix does
 * nothing. Returns the mismatch when there is one, null the rest of the time
 * (including when the answer is unknown: no marker means no claim).
 */
export function useDaemonBuildFreshness(serverId: string | null): DaemonBuildFreshness | null {
  const client = useHostRuntimeClient(serverId ?? "");
  const [stale, setStale] = useState<DaemonBuildFreshness | null>(null);

  useEffect(() => {
    if (!client) {
      setStale(null);
      return;
    }
    let disposed = false;
    const check = async () => {
      try {
        const status = await client.paseoDeployStatus();
        if (disposed) {
          return;
        }
        const builtSha = status.daemonBuiltSha ?? null;
        const deployedSha = status.deployedSha ?? null;
        setStale(
          builtSha && deployedSha && builtSha !== deployedSha ? { builtSha, deployedSha } : null,
        );
      } catch {
        // A host that doesn't know this RPC (any daemon but the self-host fork)
        // simply has nothing to say — never surface a connection hiccup as a
        // version warning.
        if (!disposed) {
          setStale(null);
        }
      }
    };
    void check();
    const timer = setInterval(() => void check(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [client]);

  return stale;
}

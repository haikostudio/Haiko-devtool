import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

/**
 * Paseo self-host deploy ("publish everything") — a personal-fork feature that
 * exposes the daemon's deploy pipeline through a desktop header button.
 *
 * The daemon RPCs live behind the `paseoSelfhostDeploy` feature flag; callers
 * must gate on `serverInfo.features.paseoSelfhostDeploy === true` before
 * mounting anything that consumes this hook.
 */

export interface PaseoDeployFileEntry {
  path: string;
  status: string;
}

export interface PaseoDeployCommitEntry {
  sha: string;
  subject: string;
}

export interface PaseoDeployStatus {
  deploying: boolean;
  hasPending: boolean;
  uncommittedFiles: PaseoDeployFileEntry[];
  unshippedCommits: PaseoDeployCommitEntry[];
  /**
   * Real number of distinct changed files vs. the live version. Optional — older
   * daemons don't send it, so callers fall back to summing the two lists.
   */
  changesCount?: number;
  headSha: string | null;
  deployedSha: string | null;
  branch: string | null;
  lastError: string | null;
  error: string | null;
}

const IDLE_REFETCH_INTERVAL_MS = 4_000;
const ACTIVE_REFETCH_INTERVAL_MS = 2_000;

export function paseoDeployStatusQueryKey(serverId: string) {
  return ["paseo-deploy-status", serverId] as const;
}

interface UsePaseoDeployStatusOptions {
  serverId: string;
  /**
   * When false the query stays disabled (no polling). Callers pass the result
   * of the `paseoSelfhostDeploy` capability check plus their own visibility
   * gate so we never poll a host that lacks the feature.
   */
  enabled: boolean;
}

export function usePaseoDeployStatus({ serverId, enabled }: UsePaseoDeployStatusOptions) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);

  const query = useFetchQuery<PaseoDeployStatus>({
    queryKey: paseoDeployStatusQueryKey(serverId),
    dataShape: "value",
    staleTimeMs: IDLE_REFETCH_INTERVAL_MS,
    queryFn: async (): Promise<PaseoDeployStatus> => {
      if (!client) {
        throw new Error("Daemon client unavailable");
      }
      return (await client.paseoDeployStatus()) as PaseoDeployStatus;
    },
    enabled: enabled && !!client && isConnected,
    refetchInterval: (q) =>
      q.state.data?.deploying ? ACTIVE_REFETCH_INTERVAL_MS : IDLE_REFETCH_INTERVAL_MS,
  });

  const status = query.data ?? null;
  // Prefer the daemon's honest file-level count; fall back to summing the lists
  // for older daemons that don't send `changesCount`. Summing lists understates
  // reality once files are grouped into a few commits — hence the preference.
  const pendingCount = status
    ? (status.changesCount ?? status.uncommittedFiles.length + status.unshippedCommits.length)
    : 0;

  return {
    status,
    pendingCount,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

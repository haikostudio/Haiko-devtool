import { useCallback, useMemo } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderUsageHistorySeries } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

/**
 * The daemon rewrites the trace every quarter hour, so anything fresher than
 * that is guaranteed identical — no point asking again.
 */
export const PROVIDER_USAGE_HISTORY_STALE_TIME_MS = 10 * 60 * 1000;

type ProviderUsageHistoryClient = Pick<DaemonClient, "getProviderUsageHistory">;

export function providerUsageHistoryQueryKey(serverId: string | null | undefined) {
  return ["providerUsageHistory", serverId ?? ""] as const;
}

async function fetchHistory(
  client: ProviderUsageHistoryClient,
): Promise<ProviderUsageHistorySeries[]> {
  const response = await client.getProviderUsageHistory();
  return response.series;
}

/**
 * The seven-day quota trace kept by the host.
 *
 * Capability-gated in one place: a host that doesn't record history simply
 * returns no series, and the curve stays off. There is no device-side fallback —
 * a trace built from whenever this device happened to be open would be a
 * different, less honest curve.
 */
export function useProviderUsageHistory(serverId: string | null | undefined): {
  series: ProviderUsageHistorySeries[];
} {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const supportsHistory = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.providerUsageHistory === true,
  );
  const queryKey = useMemo(() => providerUsageHistoryQueryKey(serverId), [serverId]);

  const queryFn = useCallback(async () => {
    if (!client) return [];
    return fetchHistory(client);
  }, [client]);

  const query = useFetchQuery({
    queryKey,
    queryFn,
    dataShape: "list",
    enabled: Boolean(serverId && client && isConnected && supportsHistory),
    staleTimeMs: PROVIDER_USAGE_HISTORY_STALE_TIME_MS,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  return { series: query.data ?? [] };
}

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ComptaMonthlyRevenue, ComptaSummaryRow } from "@getpaseo/protocol/messages";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";

export interface ComptaSummaryResult {
  /** YYYY-MM of the summarized month, null before first load. */
  month: string | null;
  rows: ComptaSummaryRow[] | null;
  /** 12-month revenue series (dominant currency), null when absent. */
  monthly: ComptaMonthlyRevenue | null;
  isLoading: boolean;
  /** At least one connected host supports the comptaSummary feature. */
  isSupported: boolean;
  refresh: () => void;
}

/**
 * Fetches the accounting summary from the first connected host advertising the
 * `comptaSummary` feature. Unlike usage stats, results are NOT merged across
 * hosts: every daemon proxies the same single accounting instance, so merging
 * would double-count the same money.
 */
export function useComptaSummary(): ComptaSummaryResult {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const featureByServer = useHostFeatureMap(serverIds, "comptaSummary");
  const [month, setMonth] = useState<string | null>(null);
  const [rows, setRows] = useState<ComptaSummaryRow[] | null>(null);
  const [monthly, setMonthly] = useState<ComptaMonthlyRevenue | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const supportedServerIds = useMemo(
    () => serverIds.filter((serverId) => featureByServer.get(serverId) === true),
    [serverIds, featureByServer],
  );
  const isSupported = supportedServerIds.length > 0;

  useEffect(() => {
    if (supportedServerIds.length === 0) {
      return;
    }
    let cancelled = false;
    const runtime = getHostRuntimeStore();
    const fetchFirst = async () => {
      setIsLoading(true);
      for (const serverId of supportedServerIds) {
        const snapshot = runtime.getSnapshot(serverId);
        if (!snapshot?.client || !isHostRuntimeConnected(snapshot)) {
          continue;
        }
        try {
          const summary = await snapshot.client.fetchComptaSummary();
          if (!cancelled) {
            setMonth(summary.month);
            setRows(summary.rows);
            setMonthly(summary.monthly);
          }
          break;
        } catch {
          // Try the next supported host.
        }
      }
      if (!cancelled) {
        setIsLoading(false);
      }
    };
    void fetchFirst();
    return () => {
      cancelled = true;
    };
  }, [supportedServerIds, refreshKey]);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  return { month, rows, monthly, isLoading, isSupported, refresh };
}

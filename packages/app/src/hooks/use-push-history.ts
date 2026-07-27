import { useCallback, useEffect, useMemo, useState } from "react";
import type { PushHistoryEntry } from "@getpaseo/protocol/messages";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";

export interface PushHistoryResult {
  /** Merged notifications across every connected host, newest first. */
  entries: PushHistoryEntry[] | null;
  isLoading: boolean;
  /** At least one connected host supports the pushHistory feature. */
  isSupported: boolean;
  refresh: () => void;
}

const FETCH_LIMIT = 200;

/**
 * Fetches the persisted push notification history from every connected host that
 * advertises the `pushHistory` feature and merges it into a single list ordered
 * newest-first. Hosts without the feature are skipped; `isSupported` is false
 * when none support it (old daemons).
 *
 * Gated behind the `pushHistory` daemon capability; callers show the panel only
 * when `isSupported` is true.
 */
export function usePushHistory(enabled: boolean): PushHistoryResult {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const featureByServer = useHostFeatureMap(serverIds, "pushHistory");
  const [entries, setEntries] = useState<PushHistoryEntry[] | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const supportedServerIds = useMemo(
    () => serverIds.filter((serverId) => featureByServer.get(serverId) === true),
    [serverIds, featureByServer],
  );
  const isSupported = supportedServerIds.length > 0;

  useEffect(() => {
    if (!enabled || supportedServerIds.length === 0) {
      return;
    }
    let cancelled = false;
    const runtime = getHostRuntimeStore();
    const fetchAll = async () => {
      setIsLoading(true);
      const results = await Promise.all(
        supportedServerIds.map(async (serverId) => {
          const snapshot = runtime.getSnapshot(serverId);
          if (!snapshot?.client || !isHostRuntimeConnected(snapshot)) {
            return null;
          }
          try {
            return await snapshot.client.fetchPushHistory(FETCH_LIMIT);
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) {
        return;
      }
      const merged = results
        .filter((result): result is PushHistoryEntry[] => result !== null)
        .flat()
        .sort((a, b) => b.sentAt - a.sentAt);
      setEntries(merged);
      setIsLoading(false);
    };
    void fetchAll();
    return () => {
      cancelled = true;
    };
  }, [enabled, supportedServerIds, refreshKey]);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  return { entries, isLoading, isSupported, refresh };
}

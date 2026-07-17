import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ActivityLogEntry } from "@getpaseo/protocol/activity/types";
import { useHostFeatureMap } from "@/runtime/host-features";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";

export type { ActivityLogEntry };

/** An activity entry tagged with the host it came from (keys are unique across hosts). */
export interface AggregatedActivityEntry extends ActivityLogEntry {
  serverId: string;
}

function createSubscriptionId(): string {
  return `activity-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

function sortEntries(entries: AggregatedActivityEntry[]): AggregatedActivityEntry[] {
  return [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export interface ActivityLogHandle {
  entries: AggregatedActivityEntry[];
  isLoading: boolean;
}

/**
 * Live global activity log aggregated across every connected host. Subscribes to
 * each host's daemon and merges activity.log.update pushes (keyed by
 * host+agentId, newest first). Re-subscribes as hosts connect/disconnect. The
 * daemon owns the log; this hook is read-only.
 */
export function useActivityLog(): ActivityLogHandle {
  const hosts = useHosts();
  const runtime = getHostRuntimeStore();
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion(),
  );

  // Per-host entry map, keyed by `${serverId}:${agentId}`. Kept in one state
  // object so a push from any host produces a single re-render.
  const [entriesByKey, setEntriesByKey] = useState<Record<string, AggregatedActivityEntry>>({});
  const [loadingHosts, setLoadingHosts] = useState(0);

  const serverIdList = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const featureMap = useHostFeatureMap(serverIdList, "activityLog");
  // Only subscribe to hosts whose daemon advertises the capability.
  const supportedIds = useMemo(
    () => serverIdList.filter((serverId) => featureMap.get(serverId) === true),
    [serverIdList, featureMap],
  );
  const supportedKey = useMemo(() => [...supportedIds].sort().join(","), [supportedIds]);

  useEffect(() => {
    void runtimeVersion;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    let pending = 0;

    for (const serverId of supportedIds) {
      const client = runtime.getClient(serverId);
      if (!client) {
        continue;
      }
      const subscriptionId = createSubscriptionId();
      pending += 1;

      const unsubscribePush = client.on("activity.log.update", (message) => {
        if (message.payload.subscriptionId !== subscriptionId) {
          return;
        }
        const entry = message.payload.entry;
        setEntriesByKey((current) => ({
          ...current,
          [`${serverId}:${entry.id}`]: { ...entry, serverId },
        }));
      });

      const runSubscribe = async () => {
        try {
          const payload = await client.activityLogSubscribe(subscriptionId);
          if (disposed || payload.error) {
            return;
          }
          setEntriesByKey((current) => {
            const next = { ...current };
            for (const entry of payload.entries) {
              next[`${serverId}:${entry.id}`] = { ...entry, serverId };
            }
            return next;
          });
        } catch {
          // Socket may already be gone; nothing to merge.
        } finally {
          if (!disposed) {
            setLoadingHosts((count) => Math.max(0, count - 1));
          }
        }
      };
      void runSubscribe();

      cleanups.push(() => {
        unsubscribePush();
        client.activityLogUnsubscribe(subscriptionId).catch(() => {
          // Server also cleans up on disconnect.
        });
      });
    }

    setLoadingHosts(pending);
    return () => {
      disposed = true;
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
    // supportedKey captures the supported host set; runtimeVersion captures
    // (re)connections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supportedKey, runtimeVersion]);

  const entries = useMemo(() => sortEntries(Object.values(entriesByKey)), [entriesByKey]);

  return useMemo(
    () => ({ entries, isLoading: loadingHosts > 0 && entries.length === 0 }),
    [entries, loadingHosts],
  );
}

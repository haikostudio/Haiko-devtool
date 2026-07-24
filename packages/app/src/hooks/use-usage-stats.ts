import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  UsageStatsDay,
  UsageStatsHourBucket,
  UsageStatsProjectBucket,
} from "@getpaseo/protocol/messages";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";
import { useHostFeatureMap } from "@/runtime/host-features";

export interface UsageStatsResult {
  /** Merged per-day stats across every connected host, oldest first. */
  days: UsageStatsDay[] | null;
  isLoading: boolean;
  /** At least one connected host supports the usageStats feature. */
  isSupported: boolean;
  refresh: () => void;
}

const FETCH_DAYS = 30;

/**
 * Fetches persisted usage stats (tokens, cost, turns, agents per project/hour)
 * from every connected host that advertises the `usageStats` feature and
 * merges them into a single per-day series. Hosts without the feature are
 * skipped; `isSupported` is false when none support it (old daemons).
 */
export function useUsageStats(): UsageStatsResult {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const featureByServer = useHostFeatureMap(serverIds, "usageStats");
  const [days, setDays] = useState<UsageStatsDay[] | null>(null);
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
    const fetchAll = async () => {
      setIsLoading(true);
      const results = await Promise.all(
        supportedServerIds.map(async (serverId) => {
          const snapshot = runtime.getSnapshot(serverId);
          if (!snapshot?.client || !isHostRuntimeConnected(snapshot)) {
            return null;
          }
          try {
            return await snapshot.client.fetchUsageStats(FETCH_DAYS);
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) {
        return;
      }
      const merged = mergeUsageStats(results.filter((result) => result !== null));
      setDays(merged);
      setIsLoading(false);
    };
    void fetchAll();
    return () => {
      cancelled = true;
    };
  }, [supportedServerIds, refreshKey]);

  const refresh = useCallback(() => {
    setRefreshKey((key) => key + 1);
  }, []);

  return { days, isLoading, isSupported, refresh };
}

function mergeUsageStats(series: UsageStatsDay[][]): UsageStatsDay[] {
  if (series.length === 0) {
    return [];
  }
  if (series.length === 1) {
    return series[0];
  }
  const byDate = new Map<string, UsageStatsDay>();
  for (const days of series) {
    for (const day of days) {
      const existing = byDate.get(day.date);
      if (!existing) {
        byDate.set(day.date, {
          date: day.date,
          projects: day.projects.map((project) => ({ ...project })),
          hours: day.hours.map((hour) => ({
            hour: hour.hour,
            projects: hour.projects.map((project) => ({ ...project })),
          })),
        });
        continue;
      }
      existing.projects = mergeProjectBuckets(existing.projects, day.projects);
      existing.hours = mergeHourBuckets(existing.hours, day.hours);
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function mergeHourBuckets(
  left: UsageStatsHourBucket[],
  right: UsageStatsHourBucket[],
): UsageStatsHourBucket[] {
  const byHour = new Map<number, UsageStatsHourBucket>();
  for (const bucket of left) {
    byHour.set(bucket.hour, bucket);
  }
  for (const bucket of right) {
    const existing = byHour.get(bucket.hour);
    if (!existing) {
      byHour.set(bucket.hour, {
        hour: bucket.hour,
        projects: bucket.projects.map((project) => ({ ...project })),
      });
      continue;
    }
    existing.projects = mergeProjectBuckets(existing.projects, bucket.projects);
  }
  return Array.from(byHour.values()).sort((a, b) => a.hour - b.hour);
}

function mergeProjectBuckets(
  left: UsageStatsProjectBucket[],
  right: UsageStatsProjectBucket[],
): UsageStatsProjectBucket[] {
  const byKey = new Map<string, UsageStatsProjectBucket>();
  for (const project of left) {
    byKey.set(project.key, { ...project });
  }
  for (const project of right) {
    const existing = byKey.get(project.key);
    if (!existing) {
      byKey.set(project.key, { ...project });
      continue;
    }
    existing.inputTokens += project.inputTokens;
    existing.outputTokens += project.outputTokens;
    existing.cachedInputTokens += project.cachedInputTokens;
    existing.costUsd += project.costUsd;
    existing.turns += project.turns;
    existing.agentCount += project.agentCount;
  }
  return Array.from(byKey.values());
}

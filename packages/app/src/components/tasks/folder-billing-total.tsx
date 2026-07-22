import { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Receipt } from "lucide-react-native";
import type { KanbanTask } from "@/data/tasks";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  BILLABLE_HOURLY_RATE_CHF,
  computeManualBillingChf,
  formatChf,
} from "@/components/tasks/task-cost";

const ThemedReceipt = withUnistyles(Receipt);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Glanceable billable total for a folder: the sum of the analysis agent's
 * senior-dev hours across the folder's tasks × the project's rate. Renders
 * nothing until the project is linked to a billing client and the total is > 0,
 * so unrelated projects never see it. Self-contained (fetches the rate itself)
 * to keep the board header free of billing plumbing.
 */
export function FolderBillingTotal({
  serverId,
  projectId,
  tasks,
}: {
  serverId: string | null;
  projectId: string | null;
  tasks: KanbanTask[];
}) {
  const supported = useHostFeature(serverId, "comptaBilling");
  const client = useHostRuntimeClient(serverId ?? "");
  // null = no linked billing client (or unsupported): the total stays hidden.
  const [rate, setRate] = useState<number | null>(null);

  useEffect(() => {
    if (!supported || !client || !projectId) {
      setRate(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const link = await client.getComptaProjectLink(projectId);
        if (!cancelled) {
          setRate(link ? (link.hourlyRateChf ?? BILLABLE_HOURLY_RATE_CHF) : null);
        }
      } catch {
        if (!cancelled) {
          setRate(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supported, client, projectId]);

  const totalHours = useMemo(
    () => tasks.reduce((sum, task) => sum + (task.estimate?.billingHours ?? 0), 0),
    [tasks],
  );

  if (rate === null || totalHours <= 0) {
    return null;
  }
  return (
    <View style={styles.row}>
      <ThemedReceipt size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      <Text style={styles.text}>{`≈ ${formatChf(computeManualBillingChf(totalHours, rate))}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));

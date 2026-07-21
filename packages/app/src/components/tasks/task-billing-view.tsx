import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Receipt } from "lucide-react-native";
import type { ComptaClient, ComptaProjectLink } from "@getpaseo/protocol/messages";
import type { KanbanTask } from "@/data/tasks";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { TaskBillingAddSheet } from "@/components/compta/task-billing-add-sheet";
import { ComptaClientPickerSheet } from "@/components/compta/compta-client-picker-sheet";
import { useToast } from "@/contexts/toast-context";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import {
  BILLABLE_HOURLY_RATE_CHF,
  computeBillableCostChf,
  formatChf,
} from "@/components/tasks/task-cost";

const ThemedReceipt = withUnistyles(Receipt);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * "Facturation" tab of the task drawer: presents the task as the billable line
 * it would become on an invoice — label (task title), estimated time, hourly
 * rate and the resulting amount — and, when the project is linked to a billing
 * client, lets the user add that line to a draft quote/invoice. The write goes
 * through the daemon's certified compta script; nothing is computed here.
 */
export function TaskBillingView({
  task,
  serverId,
  projectId,
}: {
  task: KanbanTask;
  serverId: string | null;
  projectId: string | null;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const minutes = task.estimate?.estimatedMinutes;
  const hasBilling = minutes !== undefined && minutes > 0;
  const billingSupported = useHostFeature(serverId, "comptaBilling");
  const client = useHostRuntimeClient(serverId ?? "");
  const [link, setLink] = useState<ComptaProjectLink | null>(null);
  // One-off client override for this task (defaults to the project's client).
  const [pickedClient, setPickedClient] = useState<ComptaClient | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => {
    if (!billingSupported || !client || !projectId) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const fetched = await client.getComptaProjectLink(projectId);
        if (!cancelled) {
          setLink(fetched);
        }
      } catch {
        // Non-fatal: the add action just stays hidden.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [billingSupported, client, projectId]);

  const handleOpenAdd = useCallback(() => setAddOpen(true), []);
  const handleCloseAdd = useCallback(() => setAddOpen(false), []);
  const handleOpenPicker = useCallback(() => setPickerOpen(true), []);
  const handleClosePicker = useCallback(() => setPickerOpen(false), []);
  const billingLine = useMemo(
    () => ({
      title: task.title,
      description: task.description?.trim() ? task.description.trim() : undefined,
      hours: (minutes ?? 0) / 60,
      unitPrice: BILLABLE_HOURLY_RATE_CHF,
    }),
    [task.title, task.description, minutes],
  );

  // Effective client for this task: manual pick wins over the project default.
  const effectiveClient = useMemo(() => {
    if (pickedClient) {
      return { id: pickedClient.id, name: pickedClient.name, company: pickedClient.company };
    }
    if (link) {
      return { id: link.clientId, name: link.clientName, company: link.company };
    }
    return null;
  }, [pickedClient, link]);

  // Picking a client when the project has none also becomes the project's
  // default (so the next task starts pre-filled); otherwise it stays a one-off
  // override for this task.
  const handlePickClient = useCallback(
    (picked: ComptaClient | null) => {
      if (!picked) {
        return;
      }
      setPickedClient(picked);
      if (!link && client && projectId) {
        void (async () => {
          try {
            const updated = await client.setComptaProjectLink({
              projectId,
              clientId: picked.id,
            });
            setLink(updated);
            if (updated) {
              toast.show(t("settings.project.billing.linkedTo", { name: updated.clientName }), {
                variant: "success",
              });
            }
          } catch {
            // The one-off pick still works for this task; only the default failed.
          }
        })();
      }
    },
    [link, client, projectId, toast, t],
  );

  const amount = hasBilling ? formatChf(computeBillableCostChf(minutes)) : "—";
  const rateValue = `${BILLABLE_HOURLY_RATE_CHF} CHF/h`;

  const renderAction = () => {
    if (!billingSupported) {
      return null;
    }
    if (!effectiveClient) {
      return (
        <Button onPress={handleOpenPicker} testID="task-billing-pick-client">
          {t("settings.project.billing.selectClient")}
        </Button>
      );
    }
    return (
      <View style={styles.actionBlock}>
        <View style={styles.clientRow}>
          <Text style={styles.linkedClient} numberOfLines={1}>
            {t("tasks.panel.billingLine.linkedClient", {
              name: effectiveClient.name,
              company: effectiveClient.company,
            })}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            onPress={handleOpenPicker}
            testID="task-billing-change-client"
          >
            {t("tasks.panel.billingLine.changeClient")}
          </Button>
        </View>
        <Button onPress={handleOpenAdd} testID="task-billing-add">
          {t("tasks.panel.billingLine.addButton")}
        </Button>
      </View>
    );
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t("tasks.panel.billingLine.title")}</Text>
        <Row label={t("tasks.panel.billingLine.label")} value={task.title} />
        <Row
          label={t("tasks.panel.billingLine.time")}
          value={hasBilling ? formatDuration(minutes) : "—"}
        />
        <Row label={t("tasks.panel.billingLine.rate")} value={rateValue} />
        <View style={styles.divider} />
        <Row label={t("tasks.panel.billingLine.amount")} value={amount} emphasized />
      </View>

      {!hasBilling ? (
        <View style={styles.hintRow}>
          <ThemedReceipt size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          <Text style={styles.hintText}>{t("tasks.panel.billingLine.noEstimate")}</Text>
        </View>
      ) : null}

      {renderAction()}

      <Text style={styles.note}>{t("tasks.panel.billingLine.note")}</Text>

      {serverId ? (
        <ComptaClientPickerSheet
          visible={pickerOpen}
          onClose={handleClosePicker}
          serverId={serverId}
          selectedClientId={effectiveClient?.id ?? null}
          onSelect={handlePickClient}
        />
      ) : null}

      {effectiveClient && serverId ? (
        <TaskBillingAddSheet
          visible={addOpen}
          onClose={handleCloseAdd}
          serverId={serverId}
          clientId={effectiveClient.id}
          documentTitle={task.title}
          line={billingLine}
        />
      ) : null}
    </ScrollView>
  );
}

function Row({ label, value, emphasized }: { label: string; value: string; emphasized?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={emphasized ? styles.rowValueStrong : styles.rowValue} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}

// Minutes → "Xh Ymin" (drops the hour part below 60, drops minutes when round).
function formatDuration(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  card: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  cardTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rowLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  rowValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
    textAlign: "right",
  },
  rowValueStrong: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    flexShrink: 1,
    textAlign: "right",
  },
  divider: {
    height: 1,
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[1],
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    paddingHorizontal: theme.spacing[1],
  },
  actionBlock: {
    gap: theme.spacing[2],
  },
  clientRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  linkedClient: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[1],
    flexShrink: 1,
  },
  hintRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  hintText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    flexShrink: 1,
  },
}));

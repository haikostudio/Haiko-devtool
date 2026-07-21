import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CheckCircle2, Receipt } from "lucide-react-native";
import type {
  ComptaClient,
  ComptaDocumentRef,
  ComptaProjectLink,
} from "@getpaseo/protocol/messages";
import type { KanbanTask, TaskBillingLink } from "@/data/tasks";
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
  computeManualBillingChf,
  formatChf,
} from "@/components/tasks/task-cost";

// Invoice title stays short (<= 5 words); fall back to the task title trimmed.
function toShortTitle(source: string): string {
  return source.trim().split(/\s+/).slice(0, 5).join(" ");
}

// Invoice description stays short (<= 3 lines); fall back to the task's own.
function toShortDescription(source: string): string {
  return source.trim().split(/\r?\n/).slice(0, 3).join("\n");
}

interface TaskBilling {
  billingHours: number | undefined;
  hasBilling: boolean;
  billingTitle: string;
  billingDescription: string;
}

// Resolves the invoice line the analysis agent produced (senior-dev hours +
// short title/description), falling back to the task's own fields when the
// agent omitted them. Kept out of the component to keep its complexity down.
function resolveTaskBilling(task: KanbanTask): TaskBilling {
  const estimate = task.estimate;
  const billingHours = estimate?.billingHours;
  const description = task.description?.trim() ? toShortDescription(task.description) : "";
  return {
    billingHours,
    hasBilling: billingHours !== undefined && billingHours > 0,
    billingTitle: estimate?.billingTitle?.trim() || toShortTitle(task.title),
    billingDescription: estimate?.billingDescription?.trim() || description,
  };
}

// Optimistic local link wins over the persisted one, normalized to null.
function resolveBilling(
  local: TaskBillingLink | null,
  persisted: TaskBillingLink | null | undefined,
): TaskBillingLink | null {
  return local ?? persisted ?? null;
}

const ThemedReceipt = withUnistyles(Receipt);
const ThemedCheck = withUnistyles(CheckCircle2);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.success });

/**
 * "Facturation" tab of the task drawer: presents the task as the billable line
 * it would become on an invoice — the analysis agent's short title, short
 * description, senior-developer hours (the real price, not the agent runtime),
 * the project's hourly rate and the resulting amount — and, when the project is
 * linked to a billing client, lets the user add that line to a draft
 * quote/invoice. The write goes through the daemon's certified compta script.
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
  // Billing lens produced by the analysis agent: senior-dev hours (the real
  // price, not the agent's runtime), a short invoice title and description.
  const { billingHours, hasBilling, billingTitle, billingDescription } = resolveTaskBilling(task);
  const billingSupported = useHostFeature(serverId, "comptaBilling");
  const client = useHostRuntimeClient(serverId ?? "");
  const [link, setLink] = useState<ComptaProjectLink | null>(null);
  // One-off client override for this task (defaults to the project's client).
  const [pickedClient, setPickedClient] = useState<ComptaClient | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // Optimistic reflection of a just-added billing link, so the tab shows the
  // "billed" state immediately without waiting for the board push to re-flow
  // the task prop. The persisted task.billing wins once it lands.
  const [localBilling, setLocalBilling] = useState<TaskBillingLink | null>(null);
  const billing = resolveBilling(localBilling, task.billing);

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
  // Record the compta document the line landed on onto the task itself, so the
  // task carries its billing state (and links back) across reloads. Reflect it
  // locally right away; persistence via the daemon is best-effort.
  const handleAdded = useCallback(
    (document: ComptaDocumentRef) => {
      const linkedAt = new Date().toISOString();
      const nextBilling: TaskBillingLink = {
        kind: document.kind,
        documentId: document.id,
        documentNumber: document.number,
        addedAt: linkedAt,
      };
      setLocalBilling(nextBilling);
      if (client && projectId) {
        void client
          .tasksTaskUpdate({ projectId, taskId: task.id, billing: nextBilling })
          .catch(() => {
            // Non-fatal: the line is on the document; only the task marker failed.
          });
      }
    },
    [client, projectId, task.id],
  );
  const handleOpenPicker = useCallback(() => setPickerOpen(true), []);
  const handleClosePicker = useCallback(() => setPickerOpen(false), []);
  // Project rate wins; fall back to the reference 130 CHF/h when unset.
  const rateChf = link?.hourlyRateChf ?? BILLABLE_HOURLY_RATE_CHF;
  const billingLine = useMemo(
    () => ({
      title: billingTitle,
      description: billingDescription || undefined,
      hours: billingHours ?? 0,
      unitPrice: rateChf,
    }),
    [billingTitle, billingDescription, billingHours, rateChf],
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

  const hours = billingHours ?? 0;
  const amount = hasBilling ? formatChf(computeManualBillingChf(hours, rateChf)) : "—";
  const rateValue = `${rateChf} CHF/h`;
  const hoursValue = hasBilling ? formatHours(hours) : "—";

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t("tasks.panel.billingLine.title")}</Text>
        <Row label={t("tasks.panel.billingLine.label")} value={billingTitle} />
        {billingDescription ? (
          <Row label={t("tasks.panel.billingLine.description")} value={billingDescription} />
        ) : null}
        <Row label={t("tasks.panel.billingLine.manualHours")} value={hoursValue} />
        <Row label={t("tasks.panel.billingLine.rate")} value={rateValue} />
        <View style={styles.divider} />
        <Row label={t("tasks.panel.billingLine.amount")} value={amount} emphasized />
      </View>

      <LinkedBanner billing={billing} />

      {!hasBilling ? (
        <View style={styles.hintRow}>
          <ThemedReceipt size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
          <Text style={styles.hintText}>{t("tasks.panel.billingLine.noEstimate")}</Text>
        </View>
      ) : null}

      <BillingAction
        billingSupported={billingSupported}
        effectiveClient={effectiveClient}
        alreadyLinked={billing != null}
        onOpenPicker={handleOpenPicker}
        onOpenAdd={handleOpenAdd}
      />

      {billing ? null : <Text style={styles.note}>{t("tasks.panel.billingLine.note")}</Text>}

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
          onAdded={handleAdded}
          serverId={serverId}
          clientId={effectiveClient.id}
          documentTitle={billingTitle}
          line={billingLine}
          defaultDocument={
            effectiveClient.id === link?.clientId ? (link?.defaultDocument ?? null) : null
          }
        />
      ) : null}
    </ScrollView>
  );
}

// Green "already billed" banner: the task's line is on a compta quote/invoice.
function LinkedBanner({ billing }: { billing: TaskBillingLink | null }) {
  const { t } = useTranslation();
  if (!billing) {
    return null;
  }
  const key =
    billing.kind === "invoice"
      ? "tasks.panel.billingLine.linkedInvoice"
      : "tasks.panel.billingLine.linkedQuote";
  return (
    <View style={styles.linkedBanner} testID="task-billing-linked">
      <ThemedCheck size={ICON_SIZE.sm} uniProps={successColorMapping} />
      <Text style={styles.linkedText}>{t(key, { number: billing.documentNumber })}</Text>
    </View>
  );
}

// Action row: pick a client when none is linked, otherwise the linked-client row
// plus the add/relink button. Extracted so the parent stays under its complexity
// budget.
function BillingAction({
  billingSupported,
  effectiveClient,
  alreadyLinked,
  onOpenPicker,
  onOpenAdd,
}: {
  billingSupported: boolean;
  effectiveClient: { id: string; name: string; company: string } | null;
  alreadyLinked: boolean;
  onOpenPicker: () => void;
  onOpenAdd: () => void;
}) {
  const { t } = useTranslation();
  if (!billingSupported) {
    return null;
  }
  if (!effectiveClient) {
    return (
      <Button onPress={onOpenPicker} testID="task-billing-pick-client">
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
          onPress={onOpenPicker}
          testID="task-billing-change-client"
        >
          {t("tasks.panel.billingLine.changeClient")}
        </Button>
      </View>
      <Button onPress={onOpenAdd} testID="task-billing-add">
        {alreadyLinked
          ? t("tasks.panel.billingLine.relink")
          : t("tasks.panel.billingLine.addButton")}
      </Button>
    </View>
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

// Hours → "X h" with at most one decimal (e.g. "2 h", "1.5 h").
function formatHours(hours: number): string {
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} h`;
}

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flex: 1,
    // Own the drawer's dark surface so a short billing form never leaves a pale
    // band below the content (the ScrollView is otherwise transparent).
    backgroundColor: theme.colors.surface0,
  },
  scrollContent: {
    // Grow to fill the viewport even when the content is short, so the dark
    // background paints all the way down.
    flexGrow: 1,
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
  linkedBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.success,
  },
  linkedText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
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

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
import type { KanbanTask } from "@/data/tasks";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
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

interface ResolvedBilling {
  billingHours: number | undefined;
  billingTitle: string;
  billingDescription: string;
}

// Resolves the invoice line the analysis agent produced (senior-dev hours +
// short title/description), falling back to the task's own fields when the
// agent omitted them. These values only seed the editable fields below.
function resolveTaskBilling(task: KanbanTask): ResolvedBilling {
  const estimate = task.estimate;
  const description = task.description?.trim() ? toShortDescription(task.description) : "";
  return {
    billingHours: estimate?.billingHours,
    billingTitle: estimate?.billingTitle?.trim() || toShortTitle(task.title),
    billingDescription: estimate?.billingDescription?.trim() || description,
  };
}

const ThemedReceipt = withUnistyles(Receipt);
const ThemedCheck = withUnistyles(CheckCircle2);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.success });

/**
 * "Facturation" tab of the task drawer: the task as an editable invoice line —
 * the analysis agent's short title, short description and senior-developer
 * hours (the real price, not the agent runtime) seed the fields, which the user
 * can tweak before adding. The amount is those hours × the project's rate. Once
 * added, the task is flagged as already billed. Writes go through the daemon's
 * certified compta script.
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
  const seed = resolveTaskBilling(task);
  const billingSupported = useHostFeature(serverId, "comptaBilling");
  const client = useHostRuntimeClient(serverId ?? "");
  const [link, setLink] = useState<ComptaProjectLink | null>(null);
  const [pickedClient, setPickedClient] = useState<ComptaClient | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // Editable line, seeded from the agent's output and re-seeded when a fresh
  // estimate lands (the deps are the agent values, so user edits are kept).
  const [titleDraft, setTitleDraft] = useState(seed.billingTitle);
  const [descDraft, setDescDraft] = useState(seed.billingDescription);
  const [hoursDraft, setHoursDraft] = useState(
    seed.billingHours !== undefined ? String(seed.billingHours) : "",
  );

  useEffect(() => {
    setTitleDraft(seed.billingTitle);
    setDescDraft(seed.billingDescription);
    setHoursDraft(seed.billingHours !== undefined ? String(seed.billingHours) : "");
  }, [seed.billingTitle, seed.billingDescription, seed.billingHours]);

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

  // Project rate wins; fall back to the reference 130 CHF/h when unset.
  const rateChf = link?.hourlyRateChf ?? BILLABLE_HOURLY_RATE_CHF;
  const hoursNum = Number(hoursDraft.replace(",", ".")) || 0;
  const hasBilling = hoursNum > 0;
  const billingLine = useMemo(
    () => ({
      title: titleDraft.trim() || seed.billingTitle,
      description: descDraft.trim() || undefined,
      hours: hoursNum,
      unitPrice: rateChf,
    }),
    [titleDraft, descDraft, hoursNum, rateChf, seed.billingTitle],
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
  // default; otherwise it stays a one-off override for this task.
  const handlePickClient = useCallback(
    (picked: ComptaClient | null) => {
      if (!picked) {
        return;
      }
      setPickedClient(picked);
      if (!link && client && projectId) {
        void (async () => {
          try {
            const updated = await client.setComptaProjectLink({ projectId, clientId: picked.id });
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

  // Record the document on the task so it shows as already billed.
  const handleAdded = useCallback(
    (document: ComptaDocumentRef) => {
      if (!client || !projectId) {
        return;
      }
      void client
        .tasksTaskUpdate({
          projectId,
          taskId: task.id,
          billing: {
            kind: document.kind,
            documentId: document.id,
            number: document.number,
            addedAt: new Date().toISOString(),
          },
        })
        .catch(() => {
          // Non-fatal: the line was added; only the local flag failed to persist.
        });
    },
    [client, projectId, task.id],
  );

  const amount = hasBilling ? formatChf(computeManualBillingChf(hoursNum, rateChf)) : "—";
  const rateValue = `${rateChf} CHF/h`;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {task.billing ? (
        <View style={styles.billedRow}>
          <ThemedCheck size={ICON_SIZE.sm} uniProps={successColorMapping} />
          <Text style={styles.billedText}>
            {t("tasks.panel.billingLine.alreadyBilled", { number: task.billing.number })}
          </Text>
        </View>
      ) : null}

      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t("tasks.panel.billingLine.title")}</Text>
        <Field label={t("tasks.panel.billingLine.label")}>
          <FormTextInput
            value={titleDraft}
            onChangeText={setTitleDraft}
            testID="task-billing-title"
          />
        </Field>
        <Field label={t("tasks.panel.billingLine.description")}>
          <FormTextInput
            value={descDraft}
            onChangeText={setDescDraft}
            multiline
            testID="task-billing-description"
          />
        </Field>
        <Field label={t("tasks.panel.billingLine.manualHours")}>
          <FormTextInput
            value={hoursDraft}
            onChangeText={setHoursDraft}
            keyboardType="numeric"
            testID="task-billing-hours"
          />
        </Field>
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

      <BillingAction
        supported={billingSupported}
        client={effectiveClient}
        canAdd={hasBilling}
        onPickClient={handleOpenPicker}
        onAdd={handleOpenAdd}
      />

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
          documentTitle={billingLine.title}
          line={billingLine}
          defaultDocument={
            effectiveClient.id === link?.clientId ? (link?.defaultDocument ?? null) : null
          }
          onAdded={handleAdded}
        />
      ) : null}
    </ScrollView>
  );
}

// Client row + add button (or the "pick a client" call to action). Extracted to
// keep the main component's branching under the complexity budget.
function BillingAction({
  supported,
  client,
  canAdd,
  onPickClient,
  onAdd,
}: {
  supported: boolean;
  client: { id: string; name: string; company: string } | null;
  canAdd: boolean;
  onPickClient: () => void;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  if (!supported) {
    return null;
  }
  if (!client) {
    return (
      <Button onPress={onPickClient} testID="task-billing-pick-client">
        {t("settings.project.billing.selectClient")}
      </Button>
    );
  }
  return (
    <View style={styles.actionBlock}>
      <View style={styles.clientRow}>
        <Text style={styles.linkedClient} numberOfLines={1}>
          {t("tasks.panel.billingLine.linkedClient", {
            name: client.name,
            company: client.company,
          })}
        </Text>
        <Button
          variant="ghost"
          size="sm"
          onPress={onPickClient}
          testID="task-billing-change-client"
        >
          {t("tasks.panel.billingLine.changeClient")}
        </Button>
      </View>
      <Button onPress={onAdd} disabled={!canAdd} testID="task-billing-add">
        {t("tasks.panel.billingLine.addButton")}
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
  billedRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  billedText: {
    color: theme.colors.success,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    flexShrink: 1,
  },
}));

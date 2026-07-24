import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { FilePlus, FileText } from "lucide-react-native";
import type { ComptaDocumentRef } from "@getpaseo/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { LIST_ROW_HEIGHT } from "@/components/ui/control-geometry";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { ICON_SIZE } from "@/styles/theme";

const ThemedFileText = withUnistyles(FileText);
const ThemedFilePlus = withUnistyles(FilePlus);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const NEW_ICON = <ThemedFilePlus size={ICON_SIZE.md} uniProps={mutedColorMapping} />;
const DRAFT_ICON = <ThemedFileText size={ICON_SIZE.md} uniProps={mutedColorMapping} />;

export interface TaskBillingLine {
  title: string;
  description?: string;
  hours: number;
  unitPrice: number;
}

type DocumentKind = "quote" | "invoice";

/**
 * Picker for adding a task's billable line to a draft quote/invoice: existing
 * drafts of the linked client, plus "new quote"/"new invoice" rows. The write
 * goes through the daemon (certified compta script); this only chooses the
 * target and reports the result.
 */
export function TaskBillingAddSheet({
  visible,
  onClose,
  onAdded,
  serverId,
  clientId,
  documentTitle,
  line,
  defaultDocument,
}: {
  visible: boolean;
  onClose: () => void;
  // Fired with the quote/invoice the line landed on, so the caller can record
  // the task's billing link. Runs before onClose on a successful add.
  onAdded?: (document: ComptaDocumentRef) => void;
  serverId: string;
  clientId: string;
  documentTitle: string;
  line: TaskBillingLine;
  // Project's pinned draft; surfaced first when still an open draft.
  defaultDocument?: { kind: DocumentKind; id: string } | null;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useHostRuntimeClient(serverId);
  const [drafts, setDrafts] = useState<ComptaDocumentRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible || !client) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const fetched = await client.listComptaDraftDocuments(clientId);
        if (!cancelled) {
          setDrafts(fetched);
        }
      } catch {
        if (!cancelled) {
          setDrafts([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, client, clientId]);

  const submit = useCallback(
    (kind: DocumentKind, documentId: string | null) => {
      if (!client || busy) {
        return;
      }
      setBusy(true);
      void (async () => {
        try {
          const document = await client.addTaskToComptaDocument({
            kind,
            clientId,
            documentId,
            documentTitle,
            line,
          });
          toast.show(t("tasks.panel.billingLine.added", { number: document?.number ?? "" }), {
            variant: "success",
          });
          if (document) {
            onAdded?.(document);
          }
          onClose();
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : t("tasks.panel.billingLine.addError"),
          );
        } finally {
          setBusy(false);
        }
      })();
    },
    [client, busy, clientId, documentTitle, line, toast, t, onClose, onAdded],
  );

  const header = useMemo(() => ({ title: t("tasks.panel.billingLine.addTitle") }), [t]);

  const renderDrafts = () => {
    if (loading) {
      return (
        <View style={styles.loadingRow}>
          <ActivityIndicator />
        </View>
      );
    }
    if (drafts.length === 0) {
      return null;
    }
    // Surface the project's pinned draft first (starred) when it is still open.
    const isDefault = (draft: ComptaDocumentRef) =>
      defaultDocument != null &&
      draft.kind === defaultDocument.kind &&
      draft.id === defaultDocument.id;
    const ordered = [...drafts].sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)));
    return (
      <>
        <Text style={styles.sectionLabel}>{t("tasks.panel.billingLine.existingDrafts")}</Text>
        {ordered.map((draft) => (
          <ActionRow
            key={`${draft.kind}-${draft.id}`}
            icon={DRAFT_ICON}
            label={`${isDefault(draft) ? "★ " : ""}${draft.number}${draft.title ? ` · ${draft.title}` : ""}`}
            disabled={busy}
            kind={draft.kind}
            documentId={draft.id}
            onSelect={submit}
          />
        ))}
      </>
    );
  };

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={onClose}
      header={header}
      dynamicSizing
      testID="task-billing-add-sheet"
    >
      <View style={styles.container}>
        <ActionRow
          icon={NEW_ICON}
          label={t("tasks.panel.billingLine.newInvoice")}
          disabled={busy}
          kind="invoice"
          documentId={null}
          onSelect={submit}
        />
        <ActionRow
          icon={NEW_ICON}
          label={t("tasks.panel.billingLine.newQuote")}
          disabled={busy}
          kind="quote"
          documentId={null}
          onSelect={submit}
        />

        {renderDrafts()}
      </View>
    </AdaptiveModalSheet>
  );
}

function ActionRow({
  icon,
  label,
  disabled,
  kind,
  documentId,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  kind: DocumentKind;
  documentId: string | null;
  onSelect: (kind: DocumentKind, documentId: string | null) => void;
}) {
  const handlePress = useCallback(() => onSelect(kind, documentId), [onSelect, kind, documentId]);
  const style = useMemo(() => [styles.row, disabled ? styles.rowDisabled : null], [disabled]);
  return (
    <Pressable onPress={handlePress} disabled={disabled} accessibilityRole="button" style={style}>
      {icon}
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: LIST_ROW_HEIGHT,
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
  },
  rowDisabled: {
    opacity: 0.5,
  },
  rowLabel: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  sectionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  loadingRow: {
    paddingVertical: theme.spacing[3],
    alignItems: "center",
  },
}));

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ComptaClient,
  ComptaDocumentRef,
  ComptaProjectLink,
} from "@getpaseo/protocol/messages";
import { FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { SettingsGroup } from "@/screens/settings/settings-group";
import { SettingsSection } from "@/screens/settings/settings-section";

const UNLINKED = "__none__";
const NO_DOCUMENT = "__no_document__";

// Pack/unpack the pinned document into a single select value ("kind:id").
function documentValue(doc: { kind: string; id: string }): string {
  return `${doc.kind}:${doc.id}`;
}

/**
 * Links a Paseo project to a billing client on the accounting instance and,
 * once linked, lets the user set the project's hourly rate and pin a default
 * draft document task lines land on. The mapping lives daemon-side (not in the
 * repo), so this reads/writes it over the compta RPCs directly. Rendered only
 * when the host advertises the `comptaBilling` capability.
 */
export function ProjectBillingSection({
  serverId,
  projectId,
}: {
  serverId: string;
  projectId: string;
}) {
  const { t } = useTranslation();
  const supported = useHostFeature(serverId, "comptaBilling");
  const client = useHostRuntimeClient(serverId);
  const [clients, setClients] = useState<ComptaClient[]>([]);
  const [link, setLink] = useState<ComptaProjectLink | null>(null);
  const [documents, setDocuments] = useState<ComptaDocumentRef[]>([]);
  const [rateDraft, setRateDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Draft quotes/invoices for the linked client (the pin candidates).
  const loadDocuments = useCallback(
    async (clientId: string | null) => {
      if (!client || !clientId) {
        setDocuments([]);
        return;
      }
      try {
        setDocuments(await client.listComptaDraftDocuments(clientId));
      } catch {
        setDocuments([]);
      }
    },
    [client],
  );

  useEffect(() => {
    if (!supported || !client) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const [fetchedClients, fetchedLink] = await Promise.all([
          client.listComptaClients(),
          client.getComptaProjectLink(projectId),
        ]);
        if (cancelled) {
          return;
        }
        setClients(fetchedClients);
        setLink(fetchedLink);
        setRateDraft(fetchedLink?.hourlyRateChf ? String(fetchedLink.hourlyRateChf) : "");
        setError(null);
        await loadDocuments(fetchedLink?.clientId ?? null);
      } catch (err) {
        if (!cancelled) {
          const reason = err instanceof Error ? err.message.trim() : "";
          setError(
            reason
              ? `${t("settings.project.billing.loadError")} (${reason})`
              : t("settings.project.billing.loadError"),
          );
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
  }, [supported, client, projectId, t, loadDocuments]);

  const clientOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const entries = clients.map((entry) => ({
      id: entry.id,
      value: entry.id,
      label: entry.name,
      description: entry.company,
    }));
    return [
      { id: UNLINKED, value: UNLINKED, label: t("settings.project.billing.none") },
      ...entries,
    ];
  }, [clients, t]);

  const handleClientChange = useCallback(
    (value: string) => {
      if (!client) {
        return;
      }
      const nextClientId = value === UNLINKED ? null : value;
      setSaving(true);
      void (async () => {
        try {
          const updated = await client.setComptaProjectLink({ projectId, clientId: nextClientId });
          setLink(updated);
          setRateDraft(updated?.hourlyRateChf ? String(updated.hourlyRateChf) : "");
          await loadDocuments(updated?.clientId ?? null);
          setError(null);
        } catch {
          setError(t("settings.project.billing.saveError"));
        } finally {
          setSaving(false);
        }
      })();
    },
    [client, projectId, t, loadDocuments],
  );

  // Commit the rate on blur: empty resets to the default, a valid positive
  // number sets it, anything else reverts the field to the stored value.
  const handleRateCommit = useCallback(() => {
    if (!client || !link) {
      return;
    }
    const trimmed = rateDraft.trim().replace(",", ".");
    const parsed = trimmed === "" ? null : Number(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) {
      setRateDraft(link.hourlyRateChf ? String(link.hourlyRateChf) : "");
      return;
    }
    if ((parsed ?? undefined) === link.hourlyRateChf) {
      return;
    }
    setSaving(true);
    void (async () => {
      try {
        const updated = await client.setComptaProjectLink({
          projectId,
          clientId: link.clientId,
          hourlyRateChf: parsed,
        });
        setLink(updated);
        setRateDraft(updated?.hourlyRateChf ? String(updated.hourlyRateChf) : "");
        setError(null);
      } catch {
        setError(t("settings.project.billing.saveError"));
      } finally {
        setSaving(false);
      }
    })();
  }, [client, link, rateDraft, projectId, t]);

  const documentOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const entries = documents.map((doc) => ({
      id: `${doc.kind}-${doc.id}`,
      value: documentValue(doc),
      label: `${doc.number}${doc.title ? ` · ${doc.title}` : ""}`,
    }));
    return [
      {
        id: NO_DOCUMENT,
        value: NO_DOCUMENT,
        label: t("settings.project.billing.defaultDocumentNone"),
      },
      ...entries,
    ];
  }, [documents, t]);

  const handleDocumentChange = useCallback(
    (value: string) => {
      if (!client || !link) {
        return;
      }
      const nextDoc =
        value === NO_DOCUMENT
          ? null
          : (documents.find((doc) => documentValue(doc) === value) ?? null);
      setSaving(true);
      void (async () => {
        try {
          const updated = await client.setComptaProjectLink({
            projectId,
            clientId: link.clientId,
            defaultDocument: nextDoc ? { kind: nextDoc.kind, id: nextDoc.id } : null,
          });
          setLink(updated);
          setError(null);
        } catch {
          setError(t("settings.project.billing.saveError"));
        } finally {
          setSaving(false);
        }
      })();
    },
    [client, link, documents, projectId, t],
  );

  const selectedClientDisplay = useMemo(
    () =>
      link
        ? { label: link.clientName, description: link.company }
        : { label: t("settings.project.billing.none") },
    [link, t],
  );

  const selectedDocument = link?.defaultDocument
    ? documentValue(link.defaultDocument)
    : NO_DOCUMENT;
  const selectedDocumentDisplay = useMemo(() => {
    const match = documentOptions.find((option) => option.value === selectedDocument);
    return { label: match?.label ?? t("settings.project.billing.defaultDocumentNone") };
  }, [documentOptions, selectedDocument, t]);

  if (!supported) {
    return null;
  }

  return (
    <SettingsGroup
      title={t("settings.project.billing.title")}
      info={t("settings.project.billing.info")}
      testID="billing-group"
    >
      <SettingsSection title={t("settings.project.billing.client")} testID="billing-client-section">
        <SelectField
          title={t("settings.project.billing.client")}
          value={link ? link.clientId : UNLINKED}
          selectedDisplay={selectedClientDisplay}
          options={clientOptions}
          onChange={handleClientChange}
          placeholder={t("settings.project.billing.selectClient")}
          emptyText={t("settings.project.billing.noClients")}
          loading={loading || saving}
          hint={error ?? undefined}
        />
      </SettingsSection>

      {link ? (
        <>
          <SettingsSection title={t("settings.project.billing.rate")} testID="billing-rate-section">
            <FormTextInput
              // Native-owned input: `value` is dropped, so seed with initialValue
              // and remount when the stored rate changes (load, save, revert).
              initialValue={rateDraft}
              resetKey={`${link.clientId}:${link.hourlyRateChf ?? "default"}`}
              onChangeText={setRateDraft}
              onBlur={handleRateCommit}
              keyboardType="numeric"
              placeholder={t("settings.project.billing.ratePlaceholder")}
              editable={!saving}
              testID="billing-rate-input"
            />
          </SettingsSection>

          <SettingsSection
            title={t("settings.project.billing.defaultDocument")}
            testID="billing-default-document-section"
            flush
          >
            <SelectField
              title={t("settings.project.billing.defaultDocument")}
              value={selectedDocument}
              selectedDisplay={selectedDocumentDisplay}
              options={documentOptions}
              onChange={handleDocumentChange}
              placeholder={t("settings.project.billing.defaultDocumentNone")}
              emptyText={t("settings.project.billing.defaultDocumentNone")}
              loading={loading || saving}
            />
          </SettingsSection>
        </>
      ) : null}
    </SettingsGroup>
  );
}

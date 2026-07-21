import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ComptaClient, ComptaProjectLink } from "@getpaseo/protocol/messages";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { SettingsGroup } from "@/screens/settings/settings-group";
import { SettingsSection } from "@/screens/settings/settings-section";

const UNLINKED = "__none__";

/**
 * Links a Paseo project to a billing client on the accounting instance. The
 * mapping lives daemon-side (not in the repo), so this reads/writes it over the
 * compta RPCs directly rather than through the project's paseo.yaml draft.
 * Rendered only when the host advertises the `comptaBilling` capability.
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        if (!cancelled) {
          setClients(fetchedClients);
          setLink(fetchedLink);
          setError(null);
        }
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
  }, [supported, client, projectId, t]);

  const options = useMemo<SelectFieldOption<string>[]>(() => {
    const clientOptions = clients.map((entry) => ({
      id: entry.id,
      value: entry.id,
      label: entry.name,
      description: entry.company,
    }));
    return [
      { id: UNLINKED, value: UNLINKED, label: t("settings.project.billing.none") },
      ...clientOptions,
    ];
  }, [clients, t]);

  const handleChange = useCallback(
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
          setError(null);
        } catch {
          setError(t("settings.project.billing.saveError"));
        } finally {
          setSaving(false);
        }
      })();
    },
    [client, projectId, t],
  );

  const selectedDisplay = useMemo(
    () =>
      link
        ? { label: link.clientName, description: link.company }
        : { label: t("settings.project.billing.none") },
    [link, t],
  );

  if (!supported) {
    return null;
  }

  return (
    <SettingsGroup
      title={t("settings.project.billing.title")}
      info={t("settings.project.billing.info")}
      testID="billing-group"
    >
      <SettingsSection
        title={t("settings.project.billing.client")}
        testID="billing-client-section"
        flush
      >
        <SelectField
          label={t("settings.project.billing.client")}
          value={link ? link.clientId : UNLINKED}
          selectedDisplay={selectedDisplay}
          options={options}
          onChange={handleChange}
          placeholder={t("settings.project.billing.selectClient")}
          emptyText={t("settings.project.billing.noClients")}
          loading={loading || saving}
          hint={error ?? undefined}
        />
      </SettingsSection>
    </SettingsGroup>
  );
}

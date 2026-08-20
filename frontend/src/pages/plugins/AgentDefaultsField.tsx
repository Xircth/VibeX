import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentSessionControlsSnapshot } from 'shared/types';

import { SessionControlsFields } from '@/components/sessions/SessionControlsFields';
import { useManagedAgentOptions } from '@/features/agent-management';
import { loadAgentSessionControlsCatalog } from '@/features/agents/sessionControlsQuery';
import { officialConfigFieldCopy } from './officialPlugins';

type JsonSchema = Record<string, unknown>;

export type AgentDefaultRecord = {
  modeId?: string;
  configValues?: Record<string, string>;
};

export function isAgentDefaultsSchema(
  name: string,
  schema: JsonSchema
): boolean {
  if (schema.type !== 'object') return false;
  const additional = schema.additionalProperties;
  if (
    additional &&
    typeof additional === 'object' &&
    !Array.isArray(additional)
  ) {
    const properties = (additional as { properties?: JsonSchema }).properties;
    if (
      properties &&
      typeof properties === 'object' &&
      'modeId' in properties
    ) {
      return true;
    }
  }
  return name === 'agentDefaults' && additional !== false;
}

function asRecord(value: unknown): Record<string, AgentDefaultRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const modeId =
        typeof record.modeId === 'string' && record.modeId
          ? record.modeId
          : undefined;
      const configValues =
        record.configValues &&
        typeof record.configValues === 'object' &&
        !Array.isArray(record.configValues)
          ? Object.fromEntries(
              Object.entries(
                record.configValues as Record<string, unknown>
              ).filter(
                (entry): entry is [string, string] =>
                  typeof entry[1] === 'string'
              )
            )
          : undefined;
      return [[key, { modeId, configValues }]];
    })
  );
}

function compactDefaults(
  draft: Record<string, AgentDefaultRecord>
): Record<string, AgentDefaultRecord> {
  return Object.fromEntries(
    Object.entries(draft).filter(([, record]) => {
      const values = record.configValues ?? {};
      return Boolean(record.modeId) || Object.keys(values).length > 0;
    })
  );
}

export function AgentDefaultsField({
  pluginId,
  name,
  schema,
  value,
  disabled,
  onChange,
}: {
  pluginId: string;
  name: string;
  schema: JsonSchema;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation('settings');
  const copyText = officialConfigFieldCopy(pluginId, name, schema, t);
  const agents = useManagedAgentOptions(undefined, true);
  const draft = asRecord(value);

  return (
    <fieldset className="product-plugin-agent-defaults">
      <legend className="product-plugin-config-copy">
        <strong>{copyText.title}</strong>
        {copyText.description ? <small>{copyText.description}</small> : null}
      </legend>
      {agents.length === 0 ? (
        <p className="product-plugin-muted">
          {t('plugins.agentDefaultsEmpty')}
        </p>
      ) : (
        agents.map((agent) => (
          <AgentDefaultRow
            key={agent.value}
            agentId={agent.value}
            label={agent.label}
            value={draft[agent.value] ?? {}}
            disabled={disabled}
            onChange={(next) => {
              const merged = { ...draft };
              if (
                !next.modeId &&
                Object.keys(next.configValues ?? {}).length === 0
              ) {
                delete merged[agent.value];
              } else {
                merged[agent.value] = next;
              }
              onChange(compactDefaults(merged));
            }}
          />
        ))
      )}
    </fieldset>
  );
}

function AgentDefaultRow({
  agentId,
  label,
  value,
  disabled,
  onChange,
}: {
  agentId: string;
  label: string;
  value: AgentDefaultRecord;
  disabled: boolean;
  onChange: (value: AgentDefaultRecord) => void;
}) {
  const { t } = useTranslation('settings');
  const [catalog, setCatalog] = useState<AgentSessionControlsSnapshot | null>(
    null
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    void loadAgentSessionControlsCatalog(agentId)
      .then((next) => {
        if (active) setCatalog(next);
      })
      .catch(() => {
        if (active) {
          setCatalog(null);
          setFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  return (
    <div className="product-plugin-agent-row">
      <p className="product-plugin-agent-row__name">{label}</p>
      {failed ? (
        <p className="product-plugin-muted">
          {t('plugins.agentDefaultsUnavailable')}
        </p>
      ) : catalog ? (
        <SessionControlsFields
          modes={catalog.modes}
          currentModeId={catalog.current_mode ?? null}
          configOptions={catalog.config_options}
          selectedModeId={value.modeId ?? catalog.current_mode ?? null}
          pendingConfigValues={value.configValues ?? {}}
          onSelectMode={(modeId) =>
            onChange({
              ...value,
              modeId,
            })
          }
          onSelectConfigValue={(key, next) =>
            onChange({
              ...value,
              configValues: { ...(value.configValues ?? {}), [key]: next },
            })
          }
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

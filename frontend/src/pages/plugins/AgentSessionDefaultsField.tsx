import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useBackendTransport } from '@/lib/transport';

type AgentRow = {
  agent_id: string;
  display_name: string;
  enabled?: boolean;
  lifecycle?: string;
};

type SessionMode = { id: string; name?: string };
type ConfigOption = {
  id: string;
  name?: string;
  kind?: { type?: string; values?: Array<{ value: string; name?: string }> };
};

type Defaults = {
  modeId?: string;
  configValues?: Record<string, string>;
};

const NONE = '__default__';

export function AgentSessionDefaultsField({
  value,
  disabled,
  onChange,
}: {
  value: unknown;
  disabled: boolean;
  onChange: (next: Record<string, Defaults>) => void;
}) {
  const { t } = useTranslation('settings');
  const transport = useBackendTransport();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [modes, setModes] = useState<SessionMode[]>([]);
  const [options, setOptions] = useState<ConfigOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const defaults = useMemo(() => readDefaults(value), [value]);

  useEffect(() => {
    let active = true;
    void transport
      .call('agent_management_bar')
      .then((rows) => {
        if (!active || !Array.isArray(rows)) return;
        const ready = rows.filter(
          (row): row is AgentRow =>
            isRecord(row) &&
            typeof row.agent_id === 'string' &&
            row.enabled === true &&
            row.lifecycle === 'ready'
        );
        setAgents(ready);
        setSelected((current) => current || ready[0]?.agent_id || '');
      })
      .catch(() => {
        if (active) setAgents([]);
      });
    return () => {
      active = false;
    };
  }, [transport]);

  useEffect(() => {
    if (!selected) {
      setModes([]);
      setOptions([]);
      setError(null);
      return;
    }
    let active = true;
    setError(null);
    void (async () => {
      try {
        let snapshot = await transport.call('agent_capability_catalog', {
          agentId: selected,
        });
        if (!isRecord(snapshot)) {
          await transport.call('agent_refresh_capability_catalog', {
            agentId: selected,
          });
          snapshot = await transport.call('agent_capability_catalog', {
            agentId: selected,
          });
        }
        if (!active) return;
        if (!isRecord(snapshot)) {
          setModes([]);
          setOptions([]);
          setError(t('plugins.agentDefaultsUnavailable'));
          return;
        }
        setModes(Array.isArray(snapshot.modes) ? (snapshot.modes as SessionMode[]) : []);
        setOptions(
          Array.isArray(snapshot.config_options)
            ? (snapshot.config_options as ConfigOption[]).filter(
                (option) => option.kind?.type === 'select'
              )
            : []
        );
      } catch {
        if (active) {
          setModes([]);
          setOptions([]);
          setError(t('plugins.agentDefaultsUnavailable'));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [selected, t, transport]);

  const current = defaults[selected] ?? {};

  const updateSelected = (patch: Defaults) => {
    const next = { ...defaults };
    const merged = { ...current, ...patch };
    if (!merged.modeId && !Object.keys(merged.configValues ?? {}).length) {
      delete next[selected];
    } else {
      next[selected] = merged;
    }
    onChange(next);
  };

  if (agents.length === 0) {
    return <p className="product-plugin-muted">{t('plugins.agentDefaultsEmpty')}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {agents.map((agent) => (
          <Button
            key={agent.agent_id}
            type="button"
            size="sm"
            variant={selected === agent.agent_id ? 'default' : 'outline'}
            onClick={() => setSelected(agent.agent_id)}
          >
            {agent.display_name}
          </Button>
        ))}
      </div>
      {error ? <p className="product-plugin-muted">{error}</p> : null}
      {!error && selected ? (
        <>
          {modes.length > 0 && options.every((option) => option.id !== 'mode') ? (
            <label className="product-plugin-config-row">
              <span className="product-plugin-config-copy">
                <strong>{t('plugins.agentDefaultsMode')}</strong>
              </span>
              <Select
                value={current.modeId ?? NONE}
                disabled={disabled}
                onValueChange={(value) =>
                  updateSelected({ modeId: value === NONE ? undefined : value })
                }
              >
                <SelectTrigger className="product-plugin-config-control">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('plugins.agentDefaultsInherit')}</SelectItem>
                  {modes.map((mode) => (
                    <SelectItem key={mode.id} value={mode.id}>
                      {mode.name || mode.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : null}
          {options.map((option) => (
            <label key={option.id} className="product-plugin-config-row">
              <span className="product-plugin-config-copy">
                <strong>{option.name || option.id}</strong>
              </span>
              <Select
                value={current.configValues?.[option.id] ?? NONE}
                disabled={disabled}
                onValueChange={(value) => {
                  const configValues = { ...(current.configValues ?? {}) };
                  if (value === NONE) delete configValues[option.id];
                  else configValues[option.id] = value;
                  updateSelected({ configValues });
                }}
              >
                <SelectTrigger className="product-plugin-config-control">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('plugins.agentDefaultsInherit')}</SelectItem>
                  {(option.kind?.values ?? []).map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {choice.name || choice.value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ))}
        </>
      ) : null}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readDefaults(value: unknown): Record<string, Defaults> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([agentId, raw]) => {
      if (!isRecord(raw)) return [];
      const configValues = isRecord(raw.configValues)
        ? Object.fromEntries(
            Object.entries(raw.configValues).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string'
            )
          )
        : {};
      return [
        [
          agentId,
          {
            modeId: typeof raw.modeId === 'string' ? raw.modeId : undefined,
            configValues,
          },
        ],
      ];
    })
  );
}

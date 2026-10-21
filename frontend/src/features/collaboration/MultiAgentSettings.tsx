import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Config, MultiAgentAgentDefault } from 'shared/types';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  AgentDefaultsField,
  type AgentDefaultRecord,
} from '@/pages/plugins/AgentDefaultsField';

import { CollaborationRecords } from './CollaborationRecords';
import { integerInRange } from './spaceModel';

function defaultsFromConfig(
  stored: Config['multi_agent_agent_defaults']
): Record<string, AgentDefaultRecord> {
  const next: Record<string, AgentDefaultRecord> = {};
  for (const [agentId, row] of Object.entries(stored ?? {})) {
    if (!row) continue;
    const configValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(row.config_values ?? {})) {
      if (value != null) configValues[key] = value;
    }
    next[agentId] = {
      modeId: row.mode_id ?? undefined,
      configValues,
    };
  }
  return next;
}

function defaultsToConfig(
  value: unknown
): Config['multi_agent_agent_defaults'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const next: Record<string, MultiAgentAgentDefault> = {};
  for (const [agentId, row] of Object.entries(
    value as Record<string, AgentDefaultRecord>
  )) {
    const modeId = row?.modeId?.trim() ?? '';
    const configValues = Object.fromEntries(
      Object.entries(row?.configValues ?? {}).filter(([, item]) => item.trim() !== '')
    );
    if (!modeId && Object.keys(configValues).length === 0) continue;
    next[agentId] = {
      mode_id: modeId || null,
      config_values: configValues,
    };
  }
  return next;
}

export function MultiAgentSettings({
  draft,
  hostReady,
  revision,
  updateDraft,
  onRangeError,
}: {
  draft: Config;
  hostReady: boolean;
  revision: number;
  updateDraft: (patch: Partial<Config>) => void;
  onRangeError: (message: string | null) => void;
}) {
  const { t } = useTranslation('settings');
  const [depth, setDepth] = useState(String(draft.multi_agent_depth_limit));
  const [cache, setCache] = useState(
    String(draft.multi_agent_completed_cache_max_mb)
  );
  const [days, setDays] = useState(
    String(draft.multi_agent_conversation_list_default_days)
  );
  const [hours, setHours] = useState(String(draft.multi_agent_delay_max_hours));
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    const current = draftRef.current;
    setDepth(String(current.multi_agent_depth_limit));
    setCache(String(current.multi_agent_completed_cache_max_mb));
    setDays(String(current.multi_agent_conversation_list_default_days));
    setHours(String(current.multi_agent_delay_max_hours));
  }, [revision]);

  useEffect(() => {
    const message =
      integerInRange(depth, 1, 8) == null ||
      integerInRange(cache, 0, 1_000_000) == null ||
      integerInRange(days, 1, 90) == null ||
      integerInRange(hours, 1, 168) == null
        ? t('general.multiAgentRangeError')
        : null;
    onRangeError(message);
  }, [cache, days, depth, hours, onRangeError, t]);

  const commit = (
    raw: string,
    min: number,
    max: number,
    key:
      | 'multi_agent_depth_limit'
      | 'multi_agent_completed_cache_max_mb'
      | 'multi_agent_conversation_list_default_days'
      | 'multi_agent_delay_max_hours'
  ) => {
    const parsed = integerInRange(raw, min, max);
    if (parsed != null) updateDraft({ [key]: parsed });
  };

  return (
    <div className="space-y-4">
      <div className="settings-row">
        <Label htmlFor="ma-depth">{t('general.multiAgentDepth')}</Label>
        <Input
          id="ma-depth"
          className="!w-28"
          value={depth}
          onChange={(event) => {
            setDepth(event.target.value);
            commit(event.target.value, 1, 8, 'multi_agent_depth_limit');
          }}
        />
      </div>
      <div className="settings-row">
        <Label htmlFor="ma-cache">{t('general.multiAgentCache')}</Label>
        <Input
          id="ma-cache"
          className="!w-28"
          value={cache}
          onChange={(event) => {
            setCache(event.target.value);
            commit(
              event.target.value,
              0,
              1_000_000,
              'multi_agent_completed_cache_max_mb'
            );
          }}
        />
      </div>
      <div className="settings-row">
        <Label htmlFor="ma-days">{t('general.multiAgentDays')}</Label>
        <Input
          id="ma-days"
          className="!w-28"
          value={days}
          onChange={(event) => {
            setDays(event.target.value);
            commit(
              event.target.value,
              1,
              90,
              'multi_agent_conversation_list_default_days'
            );
          }}
        />
      </div>
      <div className="settings-row">
        <Label htmlFor="ma-hours">{t('general.multiAgentHours')}</Label>
        <Input
          id="ma-hours"
          className="!w-28"
          value={hours}
          onChange={(event) => {
            setHours(event.target.value);
            commit(event.target.value, 1, 168, 'multi_agent_delay_max_hours');
          }}
        />
      </div>
      <AgentDefaultsField
        pluginId="host.multi-agent"
        name="agentDefaults"
        schema={{
          title: t('general.multiAgentDefaultsTitle'),
          description: t('general.multiAgentDefaultsHint'),
          type: 'object',
        }}
        value={defaultsFromConfig(draft.multi_agent_agent_defaults)}
        disabled={false}
        onChange={(value) =>
          updateDraft({ multi_agent_agent_defaults: defaultsToConfig(value) })
        }
      />
      {hostReady ? <CollaborationRecords /> : null}
    </div>
  );
}

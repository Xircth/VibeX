import { useEffect, useState } from 'react';
import type { AgentSessionControlsSnapshot } from 'shared/types';

import {
  advertisedSessionConfigValues,
  presentableSessionConfigOptions,
  sanitizeDependentConfigValues,
  selectConfigOptionValue,
  visibleSessionConfigOptions,
} from '@/components/tasks/follow-up/SessionConfigOptionSelectors';
import { SessionSettingsSummary } from '@/components/tasks/follow-up/SessionSettingsSummary';
import { loadAgentSessionControlsCatalog } from '@/features/agents/sessionControlsQuery';

import { COPY } from './spaceModel';

export function MemberSessionConfigControls({
  agentId,
  modeId,
  values,
  onModeId,
  onValues,
}: {
  agentId: string;
  modeId: string;
  values: Record<string, string>;
  onModeId: (modeId: string) => void;
  onValues: (values: Record<string, string>) => void;
}) {
  const [catalog, setCatalog] = useState<AgentSessionControlsSnapshot | null>(
    null
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!agentId) {
      setFailed(true);
      return;
    }
    let active = true;
    setFailed(false);
    setCatalog(null);
    void loadAgentSessionControlsCatalog(agentId)
      .then((next) => {
        if (active) setCatalog(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [agentId]);

  if (!agentId || failed) {
    return (
      <p className="settings-row__description">{COPY.controlsUnavailable}</p>
    );
  }
  if (!catalog) return null;

  const visibleConfigOptions = visibleSessionConfigOptions(
    catalog.config_options ?? []
  );
  const presentableConfigOptions = presentableSessionConfigOptions(
    visibleConfigOptions,
    catalog.modes ?? []
  );
  const advertisedConfigValues =
    advertisedSessionConfigValues(visibleConfigOptions);
  const sanitizedConfigValues = sanitizeDependentConfigValues(
    visibleConfigOptions,
    {
      ...advertisedConfigValues,
      ...values,
    }
  );
  const presentableConfigKeys = new Set(
    presentableConfigOptions.map((option) => option.key)
  );
  const configOverrides = Object.fromEntries(
    Object.entries(sanitizedConfigValues).filter(([key]) =>
      presentableConfigKeys.has(key)
    )
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      <SessionSettingsSummary
        sessionModes={{
          current: catalog.current_mode ?? null,
          modes: catalog.modes,
        }}
        options={visibleConfigOptions}
        selectedMode={modeId || catalog.current_mode || null}
        pending={configOverrides}
        onSelectMode={onModeId}
        onSelectConfigOption={(key, value) => {
          onValues(
            selectConfigOptionValue(visibleConfigOptions, values, key, value)
          );
        }}
      />
    </div>
  );
}

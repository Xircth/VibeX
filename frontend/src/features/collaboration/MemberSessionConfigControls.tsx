import { useQuery } from '@tanstack/react-query';

import {
  advertisedSessionConfigValues,
  presentableSessionConfigOptions,
  resolvedConfigOptionChoices,
  sanitizeDependentConfigValues,
  selectConfigOptionValue,
  visibleSessionConfigOptions,
} from '@/components/tasks/follow-up/SessionConfigOptionSelectors';
import { SessionSettingsSummary } from '@/components/tasks/follow-up/SessionSettingsSummary';
import {
  loadAgentSessionControlsCatalog,
  mergeCreateSessionControls,
  sessionControlsQueryKey,
  sessionControlsSchemaQueryKey,
} from '@/features/agents/sessionControlsQuery';

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
  const catalogQuery = useQuery({
    queryKey: sessionControlsQueryKey(agentId, null),
    queryFn: () => loadAgentSessionControlsCatalog(agentId),
    enabled: Boolean(agentId),
    staleTime: 60_000,
    gcTime: Infinity,
    retry: false,
  });
  const schemaQuery = useQuery({
    queryKey: sessionControlsSchemaQueryKey(agentId),
    queryFn: () => loadAgentSessionControlsCatalog(agentId),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const catalog = mergeCreateSessionControls([
    catalogQuery.data,
    schemaQuery.data,
  ]);
  const visibleConfigOptions = visibleSessionConfigOptions(
    catalog?.config_options ?? []
  );
  const presentableConfigOptions = presentableSessionConfigOptions(
    visibleConfigOptions,
    catalog?.modes ?? []
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
  const hasControls = Boolean(
    catalog &&
      (catalog.modes.length > 0 ||
        presentableConfigOptions.some(
          (option) =>
            typeof option.value === 'boolean' ||
            resolvedConfigOptionChoices(
              option,
              visibleConfigOptions,
              sanitizedConfigValues
            ).length > 1
        ))
  );

  if (!agentId || !catalog || !hasControls) return null;

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

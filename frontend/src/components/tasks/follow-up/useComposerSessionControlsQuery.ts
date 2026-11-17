import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  AgentSessionConfigOption,
  AgentSessionMode,
} from 'shared/types';
import {
  composerSessionControlDisplay,
  liveSessionControlsSnapshot,
  loadAgentSessionControlsCatalog,
  sessionControlsQueryKey,
  sessionControlsSchemaQueryKey,
} from '@/features/agents/sessionControlsQuery';
import { visibleSessionConfigOptions } from './SessionConfigOptionSelectors';
import { resolveSessionModelDisplayLabel } from './SessionSettingsSummary';

export function useComposerSessionControlsQuery({
  executor,
  workspaceId,
  selectedProviderInstanceId,
  sessionModes,
  sessionConfigOptions,
  selectedConfigValues,
  ignoreLiveControls,
}: {
  executor: string | null;
  workspaceId: string | null | undefined;
  selectedProviderInstanceId: string | null;
  sessionModes: { current: string | null; modes: AgentSessionMode[] };
  sessionConfigOptions: AgentSessionConfigOption[];
  selectedConfigValues: Record<string, string>;
  ignoreLiveControls: boolean;
}) {
  const catalogQuery = useQuery({
    queryKey: sessionControlsQueryKey(
      executor ?? '',
      null,
      selectedProviderInstanceId
    ),
    queryFn: () =>
      selectedProviderInstanceId
        ? loadAgentSessionControlsCatalog(executor, selectedProviderInstanceId)
        : loadAgentSessionControlsCatalog(executor),
    enabled: Boolean(executor),
    staleTime: 60_000,
    gcTime: Infinity,
    retry: false,
  });

  const workspaceControlsQuery = useQuery({
    queryKey: sessionControlsQueryKey(
      executor ?? '',
      workspaceId ?? '',
      selectedProviderInstanceId
    ),
    queryFn: () =>
      selectedProviderInstanceId
        ? loadAgentSessionControlsCatalog(
            executor!,
            selectedProviderInstanceId
          )
        : loadAgentSessionControlsCatalog(executor!),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  const schemaQuery = useQuery({
    queryKey: sessionControlsSchemaQueryKey(
      executor ?? '',
      selectedProviderInstanceId
    ),
    queryFn: () =>
      selectedProviderInstanceId
        ? loadAgentSessionControlsCatalog(executor!, selectedProviderInstanceId)
        : loadAgentSessionControlsCatalog(executor!),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });

  const displayControls = useMemo(
    () =>
      composerSessionControlDisplay([
        ignoreLiveControls
          ? null
          : liveSessionControlsSnapshot(sessionModes, sessionConfigOptions),
        workspaceControlsQuery.data,
        catalogQuery.data,
        schemaQuery.data,
      ]),
    [
      sessionModes,
      ignoreLiveControls,
      sessionConfigOptions,
      workspaceControlsQuery.data,
      catalogQuery.data,
      schemaQuery.data,
    ]
  );

  const displaySessionModes = displayControls.sessionModes;
  const liveModeId = displaySessionModes.current;
  const displaySessionConfigOptions = useMemo(
    () => visibleSessionConfigOptions(displayControls.sessionConfigOptions),
    [displayControls.sessionConfigOptions]
  );
  const fromModelLabel = useMemo(
    () => resolveSessionModelDisplayLabel(sessionConfigOptions, {}),
    [sessionConfigOptions]
  );
  const toModelLabel = useMemo(
    () =>
      resolveSessionModelDisplayLabel(
        displaySessionConfigOptions,
        selectedConfigValues
      ),
    [displaySessionConfigOptions, selectedConfigValues]
  );

  return {
    catalogQuery,
    displaySessionModes,
    liveModeId,
    displaySessionConfigOptions,
    fromModelLabel,
    toModelLabel,
  };
}

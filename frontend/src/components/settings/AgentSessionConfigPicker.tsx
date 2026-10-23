import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  AgentManagementView,
  AgentSessionControlsSnapshot,
} from 'shared/types';

import { SessionControlsFields } from '@/components/sessions/SessionControlsFields';
import {
  configOptionDisplayState,
  presentableSessionConfigOptions,
  resolvedConfigOptionChoices,
  visibleSessionConfigOptions,
} from '@/components/tasks/follow-up/SessionConfigOptionSelectors';
import {
  isDangerousPermissionsMode,
  presentableSessionModes,
  presentedActiveModeId,
} from '@/components/tasks/follow-up/SessionModeSelector';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { agentManagementApi } from '@/features/agent-management/api';
import { agentsApi } from '@/features/agents/api';
import {
  loadAgentSessionControlsCatalog,
  mergeCreateSessionControls,
  sessionControlsQueryKey,
  sessionControlsSchemaQueryKey,
} from '@/features/agents/sessionControlsQuery';

export function resolveEffectiveSessionConfig(
  sessionControls: AgentSessionControlsSnapshot | null,
  selectedModeId: string | null,
  pendingConfigValues: Record<string, string>
): {
  modeId: string | null;
  configValues: Record<string, string>;
} {
  if (!sessionControls) {
    return {
      modeId: selectedModeId,
      configValues: { ...pendingConfigValues },
    };
  }
  const modes = sessionControls.modes ?? [];
  const configOptions = sessionControls.config_options ?? [];
  const activeModeId = selectedModeId ?? sessionControls.current_mode ?? null;
  const presentableModes = presentableSessionModes(
    modes,
    isDangerousPermissionsMode(activeModeId),
    activeModeId
  );
  const showModeField = presentableModes.length > 0;
  const effectiveModeId = showModeField
    ? (presentedActiveModeId(modes, activeModeId) ?? selectedModeId)
    : selectedModeId;

  const visibleOptions = visibleSessionConfigOptions(configOptions);
  const dedupedOptions = presentableSessionConfigOptions(
    configOptions,
    showModeField ? modes : []
  );
  const nextConfigValues: Record<string, string> = { ...pendingConfigValues };
  for (const option of dedupedOptions) {
    if (typeof option.value === 'boolean') {
      if (nextConfigValues[option.key] === undefined) {
        nextConfigValues[option.key] = String(option.value);
      }
      continue;
    }
    const choices = resolvedConfigOptionChoices(
      option,
      visibleOptions,
      nextConfigValues
    );
    const { displayChoices, presentedActiveValue } = configOptionDisplayState(
      option,
      nextConfigValues[option.key] ?? null,
      choices
    );
    if (displayChoices.length >= 2 && presentedActiveValue) {
      nextConfigValues[option.key] = presentedActiveValue;
    }
  }

  return {
    modeId: effectiveModeId ?? null,
    configValues: nextConfigValues,
  };
}

export function AgentSessionConfigPicker({
  agentId,
  selectedModeId,
  pendingConfigValues,
  onAgentChange,
  onSelectMode,
  onSelectConfigValue,
  onSave,
  agentLabel,
}: {
  agentId: string;
  selectedModeId: string | null;
  pendingConfigValues: Record<string, string>;
  onAgentChange: (agentId: string) => void;
  onSelectMode: (modeId: string) => void;
  onSelectConfigValue: (key: string, value: string) => void;
  onSave?: (config: {
    modeId: string | null;
    configValues: Record<string, string>;
  }) => void | Promise<void>;
  agentLabel: string;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const queryClient = useQueryClient();
  const [enabledAgents, setEnabledAgents] = useState<AgentManagementView[]>([]);
  const selectedAgentId = agentId.trim();

  useEffect(() => {
    let active = true;
    void agentManagementApi
      .bar()
      .then((rows) => {
        if (!active) return;
        setEnabledAgents(rows.filter((row) => row.enabled && !row.retired));
      })
      .catch((error) => {
        toast.error(
          error instanceof Error ? error.message : t('general.agentsLoadFailed')
        );
      });
    return () => {
      active = false;
    };
  }, [t]);

  const catalogQuery = useQuery({
    queryKey: sessionControlsQueryKey(selectedAgentId, null),
    queryFn: () => loadAgentSessionControlsCatalog(selectedAgentId),
    enabled: Boolean(selectedAgentId),
    staleTime: 60_000,
    gcTime: Infinity,
    retry: false,
  });
  const schemaQuery = useQuery({
    queryKey: sessionControlsSchemaQueryKey(selectedAgentId),
    queryFn: () => loadAgentSessionControlsCatalog(selectedAgentId),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  });
  const catalogFreshnessQuery = useQuery({
    queryKey: ['agentCapabilityCatalogFreshness', selectedAgentId],
    queryFn: () => agentsApi.capabilityCatalogFresh(selectedAgentId),
    enabled: Boolean(selectedAgentId && catalogQuery.data),
    staleTime: 0,
    retry: false,
  });
  const sessionControls = mergeCreateSessionControls([
    catalogQuery.data,
    schemaQuery.data,
  ]);
  const sessionControlsLoading = catalogQuery.isFetching;
  const backgroundRefreshAgent = useRef<string | null>(null);

  useEffect(() => {
    if (
      !selectedAgentId ||
      catalogFreshnessQuery.data !== false ||
      backgroundRefreshAgent.current === selectedAgentId
    ) {
      return;
    }
    backgroundRefreshAgent.current = selectedAgentId;
    void agentsApi
      .refreshCapabilityCatalog(selectedAgentId)
      .then(async (refreshed) => {
        if (!refreshed) return;
        await catalogQuery.refetch();
        await catalogFreshnessQuery.refetch();
      })
      .catch(() => undefined);
  }, [catalogFreshnessQuery, catalogQuery, selectedAgentId]);

  useEffect(() => {
    backgroundRefreshAgent.current = null;
  }, [selectedAgentId]);

  const loadSessionControls = useCallback(
    async (nextAgentId: string, refresh: boolean) => {
      try {
        if (refresh) {
          await agentsApi.refreshCapabilityCatalog(nextAgentId);
        }
        await queryClient.fetchQuery({
          queryKey: sessionControlsQueryKey(nextAgentId, null),
          queryFn: () => loadAgentSessionControlsCatalog(nextAgentId),
          staleTime: refresh ? 0 : 60_000,
        });
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t('general.sessionControlsLoadFailed')
        );
      }
    },
    [queryClient, t]
  );

  const hasSessionControls = Boolean(
    sessionControls &&
      (sessionControls.modes.length > 0 ||
        sessionControls.config_options.length > 0)
  );

  const handleSaveSessionConfig = () => {
    const effective = resolveEffectiveSessionConfig(
      sessionControls,
      selectedModeId,
      pendingConfigValues
    );
    if (onSave) {
      void onSave(effective);
      return;
    }
    if (effective.modeId !== null && effective.modeId !== selectedModeId) {
      onSelectMode(effective.modeId);
    }
    for (const [key, value] of Object.entries(effective.configValues)) {
      if (pendingConfigValues[key] !== value) {
        onSelectConfigValue(key, value);
      }
    }
    toast.success(t('general.settingsSaved'));
  };

  return (
    <div
      className="agent-session-config-picker"
      data-testid="agent-session-config-picker"
    >
      <div className="settings-row">
        <Label className="shrink-0">{agentLabel}</Label>
        <div className="flex items-center justify-end gap-2">
          <Select
            value={selectedAgentId || undefined}
            onValueChange={onAgentChange}
            disabled={enabledAgents.length === 0}
          >
            <SelectTrigger className="!w-72" aria-label={agentLabel}>
              <SelectValue placeholder={t('general.selectAgentPlaceholder')} />
            </SelectTrigger>
            <SelectContent align="start" className="max-h-72">
              {enabledAgents.map((agent) => (
                <SelectItem
                  key={agent.agent_id}
                  value={agent.agent_id}
                  textValue={agent.display_name}
                >
                  <span className="truncate">{agent.display_name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() =>
              selectedAgentId
                ? void loadSessionControls(selectedAgentId, true)
                : undefined
            }
            disabled={!selectedAgentId || sessionControlsLoading}
            title={t('general.refreshSessionControls')}
            aria-label={t('general.refreshSessionControls')}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${
                sessionControlsLoading ? 'animate-spin' : ''
              }`}
            />
          </Button>
        </div>
      </div>

      {hasSessionControls && sessionControls ? (
        <div
          className="agent-session-config-controls-row flex items-start gap-2"
          data-testid="agent-session-config-controls-row"
        >
          <div className="min-w-0 flex-1">
            <SessionControlsFields
              modes={sessionControls.modes}
              currentModeId={sessionControls.current_mode ?? null}
              configOptions={sessionControls.config_options}
              selectedModeId={selectedModeId}
              pendingConfigValues={pendingConfigValues}
              onSelectMode={onSelectMode}
              onSelectConfigValue={onSelectConfigValue}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 px-3"
            onClick={handleSaveSessionConfig}
            data-testid="agent-session-config-save-btn"
          >
            {t('common:save', { defaultValue: '保存' })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

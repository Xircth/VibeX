import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentManagementView } from 'shared/types';

import { SessionControlsFields } from '@/components/sessions/SessionControlsFields';
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

export function AgentSessionConfigPicker({
  agentId,
  selectedModeId,
  pendingConfigValues,
  onAgentChange,
  onSelectMode,
  onSelectConfigValue,
  agentLabel,
}: {
  agentId: string;
  selectedModeId: string | null;
  pendingConfigValues: Record<string, string>;
  onAgentChange: (agentId: string) => void;
  onSelectMode: (modeId: string) => void;
  onSelectConfigValue: (key: string, value: string) => void;
  agentLabel: string;
}) {
  const { t } = useTranslation('settings');
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

  return (
    <>
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

      {sessionControls ? (
        <SessionControlsFields
          modes={sessionControls.modes}
          currentModeId={sessionControls.current_mode ?? null}
          configOptions={sessionControls.config_options}
          selectedModeId={selectedModeId}
          pendingConfigValues={pendingConfigValues}
          onSelectMode={onSelectMode}
          onSelectConfigValue={onSelectConfigValue}
        />
      ) : null}
    </>
  );
}

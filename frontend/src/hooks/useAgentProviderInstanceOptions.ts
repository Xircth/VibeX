import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import {
  buildAgentInstanceOptions,
  canonicalProviderAgentId,
  LOCAL_PROVIDER_INSTANCE_ID,
  PROVIDER_INSTANCES_CHANGED_EVENT,
  providerInstancesApi,
  supportsAgentInstances,
  type AgentInstanceOption,
  type ProviderInstanceConfig,
} from '@/lib/providerInstancesApi';

export const PROVIDER_INSTANCES_QUERY_KEY = ['provider-instances'] as const;

export function useAgentProviderInstanceOptions(
  agentId: string | null | undefined
) {
  const { t } = useTranslation(['settings', 'common']);
  const queryClient = useQueryClient();
  const canonicalAgentId = canonicalProviderAgentId(agentId);
  const supported = supportsAgentInstances(agentId);

  const query = useQuery<ProviderInstanceConfig[]>({
    queryKey: PROVIDER_INSTANCES_QUERY_KEY,
    queryFn: () => providerInstancesApi.list().catch(() => []),
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleChanged = () => {
      void queryClient.invalidateQueries({
        queryKey: PROVIDER_INSTANCES_QUERY_KEY,
      });
    };
    window.addEventListener(PROVIDER_INSTANCES_CHANGED_EVENT, handleChanged);
    return () => {
      window.removeEventListener(
        PROVIDER_INSTANCES_CHANGED_EVENT,
        handleChanged
      );
    };
  }, [queryClient]);

  const localLabel = t('settings:providerInstances.localInstance', {
    defaultValue: '本地实例',
  });

  const options = useMemo<AgentInstanceOption[]>(() => {
    if (!supported || !canonicalAgentId) return [];
    return buildAgentInstanceOptions(
      canonicalAgentId,
      query.data ?? [],
      localLabel
    );
  }, [canonicalAgentId, localLabel, query.data, supported]);

  const customInstances = useMemo(
    () =>
      (query.data ?? []).filter(
        (item) =>
          canonicalProviderAgentId(item.agentId) === canonicalAgentId &&
          item.instanceId.trim().toLowerCase() !== LOCAL_PROVIDER_INSTANCE_ID
      ),
    [canonicalAgentId, query.data]
  );

  const defaultInstanceId = useMemo(
    () =>
      options.find((option) => option.isDefault)?.instanceId ??
      LOCAL_PROVIDER_INSTANCE_ID,
    [options]
  );

  return {
    supported,
    canonicalAgentId,
    allInstances: query.data ?? [],
    instances: customInstances,
    options,
    hasMultipleInstances: supported && options.length >= 2,
    defaultInstanceId,
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

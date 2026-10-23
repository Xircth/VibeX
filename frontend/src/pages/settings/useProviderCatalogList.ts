import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePluginService, useRegistry } from '@vibex/plugin-sdk';

import { agentManagementErrorMessage as errorMessage } from '@/features/agent-management';
import {
  defaultModelCatalogProviderService,
  getModelCatalogService,
  runtimeModelCatalogRegistry,
  type ModelCatalogProviderService,
} from '@/features/plugins/providers/hostProviderServices';
import { usePluginHostContributions } from '@/hooks/usePluginHostContributions';
import { createPluginControlApi } from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';

import type { ProviderCatalogListView } from './providerCatalogTypes';

export function useProviderCatalogList(agentId: string, enabled: boolean) {
  const { t } = useTranslation('settings');
  const transport = useBackendTransport();
  const pluginApi = useMemo(
    () => createPluginControlApi(transport),
    [transport]
  );
  const catalogItems = usePluginHostContributions();
  const runtimeCatalogSources = useRegistry(runtimeModelCatalogRegistry);
  const injectedCatalogService = usePluginService<ModelCatalogProviderService>(
    'vibex.model-catalog'
  );
  const contributions = useMemo(
    () =>
      catalogItems.filter(
        (item) =>
          item.kind === 'provider_model_catalog' ||
          item.kind === 'provider_catalog'
      ),
    [catalogItems]
  );
  const catalogGeneration = contributions.reduce(
    (highest, item) => Math.max(highest, item.generation),
    0
  );
  const hasRuntimeSources = useMemo(
    () =>
      runtimeCatalogSources.some(
        (src) => src.agents.length === 0 || src.agents.includes(agentId)
      ),
    [agentId, runtimeCatalogSources]
  );
  const activeService = injectedCatalogService ?? getModelCatalogService();
  const hasCustomCatalogService =
    activeService !== defaultModelCatalogProviderService;
  const hasCatalogContributions =
    contributions.length > 0 || hasRuntimeSources || hasCustomCatalogService;
  const [catalog, setCatalog] = useState<ProviderCatalogListView | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !hasCatalogContributions) {
      setCatalog(null);
      setCatalogError(null);
      return;
    }
    let cancelled = false;
    setCatalogError(null);
    void activeService
      .listCatalog(agentId, async (id) => {
        if (contributions.length === 0) {
          return {
            agent_id: id,
            generation: catalogGeneration,
            templates: [],
            sources: [],
          };
        }
        return (await pluginApi.providerCatalogList(
          id
        )) as ProviderCatalogListView;
      })
      .then((view) => {
        if (cancelled) return;
        if (
          typeof view?.generation === 'number' &&
          view.generation < catalogGeneration
        ) {
          return;
        }
        setCatalog({
          agent_id: typeof view.agent_id === 'string' ? view.agent_id : agentId,
          generation:
            typeof view.generation === 'number'
              ? view.generation
              : catalogGeneration,
          templates: Array.isArray(view.templates) ? view.templates : [],
          sources: Array.isArray(view.sources) ? view.sources : [],
        });
      })
      .catch((cause) => {
        if (cancelled) return;
        setCatalog(null);
        setCatalogError(
          errorMessage(cause, t('agents.providerCatalogLoadFailed'))
        );
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeService,
    agentId,
    catalogGeneration,
    contributions.length,
    enabled,
    hasCatalogContributions,
    pluginApi,
    runtimeCatalogSources,
    t,
  ]);

  return {
    catalog,
    catalogError,
    catalogGeneration,
    hasCatalogContributions,
  };
}

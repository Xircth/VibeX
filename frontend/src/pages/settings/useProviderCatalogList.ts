import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { agentManagementErrorMessage as errorMessage } from '@/features/agent-management';
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
  const hasCatalogContributions = contributions.length > 0;
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
    void pluginApi
      .providerCatalogList(agentId)
      .then((payload) => {
        if (cancelled) return;
        const view = payload as ProviderCatalogListView;
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
    agentId,
    catalogGeneration,
    enabled,
    hasCatalogContributions,
    pluginApi,
    t,
  ]);

  return {
    catalog,
    catalogError,
    catalogGeneration,
    hasCatalogContributions,
  };
}

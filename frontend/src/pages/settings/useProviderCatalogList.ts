import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePluginService, useRegistry } from '@dimoai/plugin-sdk';

import { agentManagementErrorMessage as errorMessage } from '@/features/agent-management';
import {
  getModelCatalogService,
  runtimeModelCatalogRegistry,
  type ModelCatalogProviderService,
} from '@/features/plugins/providers/hostProviderServices';
import {
  hasBuiltinProviderPresets,
  loadBuiltinProviderPresets,
} from '@/features/provider-presets/builtinProviderPresets';
import { usePluginHostContributions } from '@/hooks/usePluginHostContributions';
import { createPluginControlApi } from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';

import type {
  ProviderCatalogListView,
  ProviderCatalogTemplateView,
} from './providerCatalogTypes';

/**
 * Built-in presets for the Agent, followed by templates contributed through
 * enabled `provider.model.catalog` plugins.
 */
export function useProviderCatalogList(agentId: string, enabled: boolean) {
  const { t } = useTranslation('settings');
  const transport = useBackendTransport();
  const pluginApi = useMemo(
    () => createPluginControlApi(transport),
    [transport]
  );
  const catalogItems = usePluginHostContributions();
  const runtimeCatalogSources = useRegistry(runtimeModelCatalogRegistry);
  const injectedCatalogService =
    usePluginService<ModelCatalogProviderService>('dimo.model-catalog');
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
  const hasPluginCatalogs = contributions.length > 0 || hasRuntimeSources;
  const hasPresetCatalog =
    hasBuiltinProviderPresets(agentId) || hasPluginCatalogs;
  const [catalog, setCatalog] = useState<ProviderCatalogListView | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !hasPresetCatalog) {
      setCatalog(null);
      setCatalogError(null);
      return;
    }
    let cancelled = false;
    setCatalogError(null);
    const pluginCatalog: Promise<ProviderCatalogListView | null> =
      hasPluginCatalogs
        ? activeService.listCatalog(agentId, async (id) => {
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
        : Promise.resolve(null);
    void Promise.all([
      loadBuiltinProviderPresets(agentId),
      pluginCatalog.then(
        (view) => ({ view, error: null }),
        (cause: unknown) => ({ view: null, error: cause })
      ),
    ]).then(([builtin, plugin]) => {
      if (cancelled) return;
      const view = plugin.view;
      if (
        typeof view?.generation === 'number' &&
        view.generation < catalogGeneration
      ) {
        return;
      }
      const pluginTemplates: ProviderCatalogTemplateView[] = Array.isArray(
        view?.templates
      )
        ? view.templates
        : [];
      setCatalog({
        agent_id: agentId,
        generation:
          typeof view?.generation === 'number'
            ? view.generation
            : catalogGeneration,
        templates: [...builtin, ...pluginTemplates],
        sources: Array.isArray(view?.sources) ? view.sources : [],
      });
      setCatalogError(
        plugin.error
          ? errorMessage(plugin.error, t('agents.providerCatalogLoadFailed'))
          : null
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
    hasPresetCatalog,
    hasPluginCatalogs,
    pluginApi,
    runtimeCatalogSources,
    t,
  ]);

  return {
    catalog,
    catalogError,
    catalogGeneration,
    hasPresetCatalog,
  };
}

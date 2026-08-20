import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/components/ui/toast';
import {
  createPluginControlApi,
  type PluginControlItem,
} from '@/lib/api/plugins';

export const pluginCatalogQueryKey = ['plugin-control-catalog'] as const;
export const pluginContributionCatalogQueryKey = [
  'plugin-contribution-catalog',
] as const;

export function pluginDetailQueryKey(pluginId: string) {
  return ['plugin-product-detail', pluginId] as const;
}

export function isProductPlugin(plugin: PluginControlItem) {
  return !['codex_native', 'claude_code_native'].includes(plugin.sourceKind);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function useProductPluginCatalog(
  api: ReturnType<typeof createPluginControlApi>
) {
  const { t } = useTranslation('settings');
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: pluginCatalogQueryKey,
    queryFn: async () => {
      try {
        const catalog = await api.catalog();
        return catalog.plugins.filter(isProductPlugin);
      } catch (error) {
        toast.error(t('plugins.productCatalogFailed'), {
          description: errorMessage(error),
        });
        throw error;
      }
    },
    staleTime: Infinity,
    gcTime: 1000 * 60 * 30,
    retry: false,
  });

  const setPlugins = useCallback(
    (
      updater:
        | PluginControlItem[]
        | ((current: PluginControlItem[]) => PluginControlItem[])
    ) => {
      queryClient.setQueryData<PluginControlItem[]>(
        pluginCatalogQueryKey,
        (current = []) =>
          typeof updater === 'function' ? updater(current) : updater
      );
    },
    [queryClient]
  );

  const refresh = useCallback(
    async (showLoading = true) => {
      if (showLoading) {
        await queryClient.invalidateQueries({
          queryKey: pluginCatalogQueryKey,
        });
        return;
      }
      await queryClient.refetchQueries({
        queryKey: pluginCatalogQueryKey,
        type: 'active',
      });
    },
    [queryClient]
  );

  return {
    plugins: query.data ?? [],
    loading: query.isPending,
    setPlugins,
    refresh,
  };
}

export function useProductPluginDetail(
  api: ReturnType<typeof createPluginControlApi>,
  pluginId: string
) {
  const { t } = useTranslation('settings');
  return useQuery({
    queryKey: pluginDetailQueryKey(pluginId),
    queryFn: async () => {
      try {
        return await api.productDetail(pluginId);
      } catch (error) {
        toast.error(t('plugins.productDetailFailed'), {
          description: errorMessage(error),
        });
        throw error;
      }
    },
    enabled: Boolean(pluginId),
    staleTime: Infinity,
    gcTime: 1000 * 60 * 30,
    retry: false,
  });
}

export function usePluginContributionCatalog(
  api: ReturnType<typeof createPluginControlApi>
) {
  return useQuery({
    queryKey: pluginContributionCatalogQueryKey,
    queryFn: () => api.contributionCatalog(),
    staleTime: Infinity,
    gcTime: 1000 * 60 * 30,
    retry: false,
  });
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';

import { backendListen } from '@/lib/backendTransport';
import {
  createPluginControlApi,
  type PluginContributionCatalogItem,
} from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';

export const pluginContributionCatalogQueryKey = [
  'plugin-contribution-catalog',
] as const;

const CONTRIBUTIONS_CHANGED_EVENT = 'plugin-contributions-changed';

const EMPTY: PluginContributionCatalogItem[] = [];

/**
 * Keeps Host chrome in step with plugin activation. The Host republishes the
 * catalog whenever a generation is published or withdrawn, so enabling a plugin
 * shows its contributions immediately and disabling removes them atomically
 * (ADR-0069 principle 4) — including when the CLI drives the change.
 */
export function usePluginContributionCatalogSync() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void backendListen(CONTRIBUTIONS_CHANGED_EVENT, () => {
      void queryClient.invalidateQueries({
        queryKey: pluginContributionCatalogQueryKey,
      });
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [queryClient]);
}

export function usePluginHostContributions(
  kind?: PluginContributionCatalogItem['kind']
) {
  const transport = useBackendTransport();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const { data } = useQuery({
    queryKey: pluginContributionCatalogQueryKey,
    queryFn: () => api.contributionCatalog(),
    staleTime: 30_000,
    retry: false,
  });

  const items = data?.items ?? EMPTY;
  return useMemo(
    () => (kind ? items.filter((item) => item.kind === kind) : items),
    [items, kind]
  );
}

export function contributionMetadata(
  item: PluginContributionCatalogItem
): Record<string, unknown> {
  if (
    !item.metadata ||
    typeof item.metadata !== 'object' ||
    Array.isArray(item.metadata)
  ) {
    return {};
  }
  return item.metadata as Record<string, unknown>;
}

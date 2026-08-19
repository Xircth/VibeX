import { useEffect, useMemo, useState } from 'react';

import {
  createPluginControlApi,
  type PluginContributionCatalogItem,
} from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';

export function usePluginHostContributions(kind?: PluginContributionCatalogItem['kind']) {
  const transport = useBackendTransport();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const [items, setItems] = useState<PluginContributionCatalogItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    void api
      .contributionCatalog()
      .then((catalog) => {
        if (!cancelled) setItems(catalog.items);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  return useMemo(
    () => (kind ? items.filter((item) => item.kind === kind) : items),
    [items, kind]
  );
}

export function contributionMetadata(
  item: PluginContributionCatalogItem
): Record<string, unknown> {
  if (!item.metadata || typeof item.metadata !== 'object' || Array.isArray(item.metadata)) {
    return {};
  }
  return item.metadata as Record<string, unknown>;
}

import { useMemo } from 'react';
import { usePluginHostContributions } from '@/hooks/usePluginHostContributions';
import { kanbanViewsFromCatalog } from '@/lib/kanbanViewCatalog';
import type { KanbanViewDescriptor } from '@/lib/kanbanViews';

export function useKanbanViews(): KanbanViewDescriptor[] {
  const catalog = usePluginHostContributions();
  return useMemo(() => kanbanViewsFromCatalog(catalog), [catalog]);
}

import { useMemo } from 'react';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { pluginSurfaceId } from '@/lib/hostSurfaceIds';
import {
  BUILTIN_KANBAN_VIEWS,
  type KanbanViewDescriptor,
} from '@/lib/kanbanViews';

export function useKanbanViews(): KanbanViewDescriptor[] {
  const contributed = usePluginHostContributions('kanban_view');
  return useMemo(() => {
    const pluginViews = contributed.map((item) => {
      const metadata = contributionMetadata(item);
      return {
        id: pluginSurfaceId(item.pluginId, item.id),
        titleKey: item.label,
        hidesBottomDock: metadata.hidesBottomDock !== false,
        builtin: false,
        pluginId: item.pluginId,
        contributionId: item.id,
      } satisfies KanbanViewDescriptor;
    });
    return [...BUILTIN_KANBAN_VIEWS, ...pluginViews];
  }, [contributed]);
}

import type { PluginContributionCatalogItem } from '@/lib/api/plugins';
import { contributionMetadata } from '@/hooks/usePluginHostContributions';
import { pluginSurfaceId } from '@/lib/hostSurfaceIds';
import {
  BUILTIN_KANBAN_VIEWS,
  type KanbanViewDescriptor,
} from '@/lib/kanbanViews';

const KANBAN_VIEW_SLOT = 'app.kanban.view';

export function isKanbanViewContribution(
  item: PluginContributionCatalogItem
): boolean {
  if (item.kind === 'kanban_view') return true;
  return (
    item.kind === 'app_surface' &&
    contributionMetadata(item).slot === KANBAN_VIEW_SLOT
  );
}

export function kanbanViewsFromCatalog(
  items: readonly PluginContributionCatalogItem[]
): KanbanViewDescriptor[] {
  const seen = new Set<string>();
  const pluginViews: KanbanViewDescriptor[] = [];
  for (const item of items) {
    if (!isKanbanViewContribution(item)) continue;
    const id = pluginSurfaceId(item.pluginId, item.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const metadata = contributionMetadata(item);
    pluginViews.push({
      id,
      titleKey: item.label,
      hidesBottomDock: metadata.hidesBottomDock !== false,
      builtin: false,
      pluginId: item.pluginId,
      contributionId: item.id,
    });
  }
  return [...BUILTIN_KANBAN_VIEWS, ...pluginViews];
}

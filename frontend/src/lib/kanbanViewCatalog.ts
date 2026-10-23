import {
  kanbanViewRegistry,
  type KanbanViewContribution,
} from '@vibex/plugin-sdk';
import type { PluginContributionCatalogItem } from '@/lib/api/plugins';
import { contributionMetadata } from '@/hooks/usePluginHostContributions';
import { pluginSurfaceId } from '@/lib/hostSurfaceIds';
import {
  BUILTIN_KANBAN_VIEWS,
  type KanbanViewDescriptor,
} from '@/lib/kanbanViews';

const KANBAN_VIEW_SLOT = 'app.kanban.view';

export function registerBuiltinKanbanViews(): void {
  for (let i = 0; i < BUILTIN_KANBAN_VIEWS.length; i += 1) {
    const view = BUILTIN_KANBAN_VIEWS[i];
    if (!kanbanViewRegistry.has(view.id)) {
      kanbanViewRegistry.register(
        {
          id: view.id,
          title: view.titleKey,
          titleKey: view.titleKey,
          hidesBottomDock: view.hidesBottomDock,
          builtin: true,
          order: (i + 1) * 10,
        },
        'builtin'
      );
    }
  }
}

registerBuiltinKanbanViews();

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
  items: readonly PluginContributionCatalogItem[],
  sdkContributions: readonly KanbanViewContribution[] = kanbanViewRegistry.getAll()
): KanbanViewDescriptor[] {
  const seen = new Set<string>(BUILTIN_KANBAN_VIEWS.map((v) => v.id));
  const pluginViews: KanbanViewDescriptor[] = [];

  for (const sdkView of sdkContributions) {
    if (sdkView.builtin || sdkView.id.startsWith('builtin:')) continue;
    const pluginId = sdkView.pluginId ?? 'plugin';
    const rawId = sdkView.id.startsWith(`${pluginId}:`)
      ? sdkView.id.slice(pluginId.length + 1)
      : sdkView.id;
    const id = pluginSurfaceId(pluginId, rawId);
    if (seen.has(id)) continue;
    seen.add(id);
    pluginViews.push({
      id,
      titleKey: sdkView.titleKey ?? sdkView.title,
      hidesBottomDock: sdkView.hidesBottomDock !== false,
      builtin: false,
      pluginId,
      contributionId: rawId,
    });
  }

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

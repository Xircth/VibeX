import {
  type Disposer,
  kanbanViewRegistry,
  type KanbanViewContribution,
  type VibeXPluginContext,
} from '@vibex/plugin-sdk';
import type { PluginContributionCatalogItem } from '@/lib/api/plugins';
import { contributionMetadata } from '@/hooks/usePluginHostContributions';
import { pluginSurfaceId } from '@/lib/hostSurfaceIds';
import {
  BUILTIN_KANBAN_VIEWS,
  type KanbanViewDescriptor,
} from '@/lib/kanbanViews';

const KANBAN_VIEW_SLOT = 'app.kanban.view';

export interface RegisterBuiltinKanbanViewsOptions {
  readonly ctx?: VibeXPluginContext;
  readonly viewIds?: readonly string[];
  readonly pluginId?: string;
}

export function registerBuiltinKanbanViews(
  options?: RegisterBuiltinKanbanViewsOptions
): Disposer {
  const allowedIds = options?.viewIds ? new Set(options.viewIds) : null;
  const disposers: Disposer[] = [];
  const ownerPluginId =
    options?.ctx?.pluginId ?? options?.pluginId ?? 'builtin';

  for (let i = 0; i < BUILTIN_KANBAN_VIEWS.length; i += 1) {
    const view = BUILTIN_KANBAN_VIEWS[i];
    if (allowedIds && !allowedIds.has(view.id)) {
      continue;
    }
    const contribution: Omit<KanbanViewContribution, 'pluginId'> = {
      id: view.id,
      title: view.titleKey,
      titleKey: view.titleKey,
      hidesBottomDock: view.hidesBottomDock,
      builtin: true,
      order: (i + 1) * 10,
    };
    if (options?.ctx) {
      disposers.push(options.ctx.ui.registerKanbanView(contribution));
    } else {
      disposers.push(
        kanbanViewRegistry.register(
          { ...contribution, pluginId: ownerPluginId },
          ownerPluginId
        )
      );
    }
  }

  const cleanup: Disposer = () => {
    for (let i = disposers.length - 1; i >= 0; i -= 1) {
      disposers[i]?.();
    }
  };

  if (options?.ctx) {
    options.ctx.effect(() => cleanup);
  }

  return cleanup;
}

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
  const seen = new Set<string>();
  const builtinViews: Array<{
    descriptor: KanbanViewDescriptor;
    order: number;
  }> = [];
  const pluginViews: KanbanViewDescriptor[] = [];

  for (let i = 0; i < sdkContributions.length; i += 1) {
    const sdkView = sdkContributions[i];
    if (!sdkView) continue;
    const pluginId = sdkView.pluginId ?? 'plugin';
    const rawId = sdkView.id.startsWith(`${pluginId}:`)
      ? sdkView.id.slice(pluginId.length + 1)
      : sdkView.id.startsWith('builtin:')
        ? sdkView.id.slice('builtin:'.length)
        : sdkView.id;

    if (sdkView.builtin || sdkView.id.startsWith('builtin:')) {
      if (seen.has(rawId)) continue;
      seen.add(rawId);
      builtinViews.push({
        descriptor: {
          id: rawId,
          titleKey: sdkView.titleKey ?? sdkView.title,
          hidesBottomDock: sdkView.hidesBottomDock !== false,
          builtin: true,
        },
        order: sdkView.order ?? (i + 1) * 10,
      });
      continue;
    }

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

  builtinViews.sort((a, b) => a.order - b.order);

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

  return [...builtinViews.map((entry) => entry.descriptor), ...pluginViews];
}

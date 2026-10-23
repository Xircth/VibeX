import {
  useKanbanViewContributions,
  usePanels,
  useSettingsPages,
  useViews,
} from '@vibex/plugin-sdk';
import { AppSurfaceHost } from '@/components/plugins/AppSurfaceHost';
import { PluginBoundary } from '@/components/plugins/PluginBoundary';
import { PluginSurfacePlaceholder } from '@/components/plugins/PluginSurfacePlaceholder';
import { createBackendAppSurfaceTransport } from '@/lib/api/appSurfaceTransport';
import { configuredBackendTransport } from '@/lib/backendTransport';
import type { PluginContributionCatalogItem } from '@/lib/api/plugins';
import { contributionMetadata } from '@/hooks/usePluginHostContributions';
import { useMemo, useState, type ReactNode } from 'react';

const transport = createBackendAppSurfaceTransport(configuredBackendTransport);

export function PluginRemoteView({
  item,
  slot,
  enabled = true,
  workspaceId = null,
  projectId = null,
}: {
  item: PluginContributionCatalogItem | null;
  slot:
    | 'app.panel'
    | 'app.tab'
    | 'app.kanban.view'
    | 'app.settings.page'
    | 'status.after-mcp';
  enabled?: boolean;
  workspaceId?: string | null;
  projectId?: string | null;
}) {
  const [retry, setRetry] = useState(0);
  if (!enabled) {
    return <PluginSurfacePlaceholder reason="disabled" />;
  }
  if (!item) {
    return <PluginSurfacePlaceholder reason="missing" />;
  }
  return (
    <PluginBoundary
      pluginId={item.pluginId}
      slot={slot}
      onRetry={() => setRetry((current) => current + 1)}
      fallback={({ quarantined, retry: recover }) =>
        quarantined ? undefined : (
          <PluginSurfacePlaceholder reason="failed" onRecover={recover} />
        )
      }
    >
      <PluginRemoteViewBody
        key={`${item.pluginId}:${item.id}:${retry}`}
        item={item}
        slot={slot}
        workspaceId={workspaceId}
        projectId={projectId}
      />
    </PluginBoundary>
  );
}

function PluginRemoteViewBody({
  item,
  slot,
  workspaceId,
  projectId,
}: {
  item: PluginContributionCatalogItem;
  slot:
    | 'app.panel'
    | 'app.tab'
    | 'app.kanban.view'
    | 'app.settings.page'
    | 'status.after-mcp';
  workspaceId: string | null;
  projectId: string | null;
}) {
  const registeredViews = useViews();
  const registeredPanels = usePanels();
  const registeredKanbanViews = useKanbanViewContributions();
  const registeredSettingsPages = useSettingsPages();
  const registeredView = useMemo(() => {
    const matchId = (candidate: { pluginId?: string; id: string }) =>
      candidate.pluginId === item.pluginId &&
      (candidate.id === item.id ||
        candidate.id === `${item.pluginId}:${item.id}` ||
        candidate.id === `plugin:${item.pluginId}/${item.id}`);
    return (
      registeredViews.find(matchId) ??
      registeredPanels.find(matchId) ??
      registeredKanbanViews.find(matchId) ??
      registeredSettingsPages.find(matchId) ??
      null
    );
  }, [
    item.id,
    item.pluginId,
    registeredKanbanViews,
    registeredPanels,
    registeredSettingsPages,
    registeredViews,
  ]);

  const metadata = contributionMetadata(item);
  const surfaceId = item.id;

  const surface = useMemo(
    () => ({
      pluginId: item.pluginId,
      surfaceId,
      label: item.label,
      generation: item.generation,
      allowedMethods: Array.isArray(metadata.allowedMethods)
        ? metadata.allowedMethods.filter(
            (method): method is string => typeof method === 'string'
          )
        : [],
      slot,
    }),
    [item, metadata.allowedMethods, slot, surfaceId]
  );

  const surfaceVariant =
    slot === 'app.tab' ||
    slot === 'app.kanban.view' ||
    slot === 'app.settings.page'
      ? 'editor'
      : 'panel';

  const registeredRender =
    registeredView && 'render' in registeredView
      ? registeredView.render
      : undefined;

  if (registeredView?.component) {
    const RegisteredComponent = registeredView.component;
    return (
      <div className="relative h-full w-full" data-testid="plugin-remote-view">
        <RegisteredComponent
          pluginId={item.pluginId}
          surfaceId={surfaceId}
          slot={slot}
          workspaceId={workspaceId}
          projectId={projectId}
        />
      </div>
    );
  }

  if (typeof registeredRender === 'function') {
    return (
      <div className="relative h-full w-full" data-testid="plugin-remote-view">
        {
          registeredRender({
            pluginId: item.pluginId,
            surfaceId,
            slot,
            workspaceId,
            projectId,
          }) as ReactNode
        }
      </div>
    );
  }

  return (
    <AppSurfaceHost
      descriptor={surface}
      enabled
      transport={transport}
      variant={surfaceVariant}
    />
  );
}

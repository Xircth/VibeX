import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { PluginRemoteView } from '@/components/plugins/PluginRemoteView';
import { PluginSurfacePlaceholder } from '@/components/plugins/PluginSurfacePlaceholder';
import { HostBrowserSettingsPage } from '@/features/host-browser/HostBrowserSettingsPage';
import { isHostBrowserPlugin } from '@/features/host-browser/hostBrowserEngine';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';

export function PluginSettingsPage() {
  const { pluginId, pageId } = useParams<{
    pluginId: string;
    pageId: string;
  }>();
  const pages = usePluginHostContributions('settings_page');
  const allContributions = usePluginHostContributions();
  const item = useMemo(
    () =>
      pages.find((page) => page.pluginId === pluginId && page.id === pageId) ??
      null,
    [pageId, pages, pluginId]
  );

  if (!item) {
    return <PluginSurfacePlaceholder reason="missing" />;
  }

  if (
    isHostBrowserPlugin(
      item.pluginId,
      allContributions,
      contributionMetadata(item)
    )
  ) {
    return <HostBrowserSettingsPage pluginId={item.pluginId} />;
  }

  return (
    <div className="h-full min-h-[24rem]">
      <PluginRemoteView item={item} slot="app.settings.page" enabled />
    </div>
  );
}

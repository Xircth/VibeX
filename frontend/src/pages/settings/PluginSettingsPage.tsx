import { useSettingsPages } from '@vibex/plugin-sdk';
import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { PluginBoundary } from '@/components/plugins/PluginBoundary';
import { PluginRemoteView } from '@/components/plugins/PluginRemoteView';
import { PluginSchemaSettingsForm } from '@/components/plugins/PluginSchemaSettingsForm';
import { PluginSurfacePlaceholder } from '@/components/plugins/PluginSurfacePlaceholder';
import { usePluginHostContributions } from '@/hooks/usePluginHostContributions';
import type { PluginContributionCatalogItem } from '@/lib/api/plugins';

export function PluginSettingsPage() {
  const { pluginId, pageId } = useParams<{
    pluginId: string;
    pageId: string;
  }>();
  const pages = usePluginHostContributions('settings_page');
  const sdkPages = useSettingsPages();

  const sdkPageMatch = useMemo(
    () =>
      sdkPages.find(
        (page) =>
          page.pluginId === pluginId &&
          (page.id === pageId || page.id === `${pluginId}:${pageId}`)
      ) ?? null,
    [pageId, pluginId, sdkPages]
  );

  const item = useMemo<PluginContributionCatalogItem | null>(() => {
    const catalogMatch = pages.find(
      (page) => page.pluginId === pluginId && page.id === pageId
    );
    if (catalogMatch) return catalogMatch;
    if (!pluginId || !pageId || !sdkPageMatch) return null;
    return {
      pluginId,
      id: pageId,
      kind: 'settings_page',
      label: sdkPageMatch.title,
      generation: 1,
      metadata: sdkPageMatch.icon ? { icon: sdkPageMatch.icon } : {},
    };
  }, [pageId, pages, pluginId, sdkPageMatch]);

  if (!item) {
    return <PluginSurfacePlaceholder reason="missing" />;
  }

  if (
    sdkPageMatch?.schema &&
    !sdkPageMatch.component &&
    !sdkPageMatch.render &&
    pluginId
  ) {
    return (
      <div className="h-full min-h-[24rem]">
        <PluginBoundary pluginId={pluginId} slot="app.settings.page">
          <PluginSchemaSettingsForm
            pluginId={pluginId}
            schema={sdkPageMatch.schema}
            title={sdkPageMatch.title}
            description={sdkPageMatch.description}
          />
        </PluginBoundary>
      </div>
    );
  }

  return (
    <div className="h-full min-h-[24rem]">
      <PluginRemoteView item={item} slot="app.settings.page" enabled />
    </div>
  );
}

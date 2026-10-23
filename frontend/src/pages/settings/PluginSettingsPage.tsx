import { useSettingSections, useSettingsPages } from '@vibex/plugin-sdk';
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
  const sdkSections = useSettingSections();

  const sdkPageMatch = useMemo(
    () =>
      sdkPages.find(
        (page) =>
          page.pluginId === pluginId &&
          (page.id === pageId || page.id === `${pluginId}:${pageId}`)
      ) ?? null,
    [pageId, pluginId, sdkPages]
  );

  const sdkSectionMatch = useMemo(
    () =>
      sdkSections.find(
        (section) =>
          section.pluginId === pluginId &&
          (section.id === pageId || section.id === `${pluginId}:${pageId}`)
      ) ?? null,
    [pageId, pluginId, sdkSections]
  );

  const item = useMemo<PluginContributionCatalogItem | null>(() => {
    const catalogMatch = pages.find(
      (page) => page.pluginId === pluginId && page.id === pageId
    );
    if (catalogMatch) return catalogMatch;
    if (!pluginId || !pageId) return null;
    const sdkEntry = sdkPageMatch ?? sdkSectionMatch;
    if (!sdkEntry) return null;
    return {
      pluginId,
      id: pageId,
      kind: 'settings_page',
      label: sdkEntry.title,
      generation: 1,
      metadata: sdkEntry.icon ? { icon: sdkEntry.icon } : {},
    };
  }, [pageId, pages, pluginId, sdkPageMatch, sdkSectionMatch]);

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

  if (sdkSectionMatch?.component && !sdkPageMatch && pluginId) {
    const SectionComponent = sdkSectionMatch.component;
    return (
      <div className="h-full min-h-[24rem]">
        <PluginBoundary pluginId={pluginId} slot="app.settings.page">
          <SectionComponent
            pluginId={pluginId}
            surfaceId={pageId}
            slot="app.settings.page"
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

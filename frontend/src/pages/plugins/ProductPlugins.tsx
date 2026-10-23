import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pickHostFile } from '@/lib/hostFs';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  Puzzle,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { AppSurfaceHost } from '@/components/plugins/AppSurfaceHost';
import { ProductContextMenu } from '@/components/context-menu/ProductContextMenu';
import type { ProductContextMenuItem } from '@/components/context-menu/contextMenuTypes';
import {
  CORE_PLUGIN_PLANES,
  useCoreFoundationInventory,
  type CoreFoundationArtworkKey,
  type CorePluginRuntimeSnapshot,
} from '@/features/plugins/coreFoundationPlugins';
import { syncMonorepoPluginRuntime } from '@/features/plugins/monorepoPluginBootstrap';
import {
  appSurfaceDescriptors,
  createBackendAppSurfaceTransport,
} from '@/lib/api/appSurfaceTransport';
import {
  createPluginControlApi,
  type PluginContributionCatalog,
  type CatalogListing,
  type CatalogPage,
  type PluginControlItem,
  type PluginImportPreview,
  type PluginProductDetail,
  type PluginUpdateStatus,
} from '@/lib/api/plugins';
import { useBackendCapabilities, useBackendTransport } from '@/lib/transport';
import {
  OFFICIAL_MARKETPLACE_WEB_URL,
  PluginCatalogActions,
  PluginCatalogLoading,
  PluginDetailLoading,
  PluginDropOverlay,
} from './PluginCatalogControls';
import { PluginInstallTrustDialog } from './PluginInstallTrustDialog';
import {
  PluginCatalogModeTabs,
  PluginMarketplaceList,
  type PluginCatalogMode,
} from './PluginMarketplace';
import { findInstalledPluginForListing } from './marketplaceListing';
import { PluginConfigForm } from './PluginConfigForm';
import {
  PluginContentsView,
  PluginPackageTree,
  PluginReadmeView,
} from './PluginContentBrowser';
import { PluginInspectTabs, type PluginInspectTab } from './PluginDetailTabs';
import { PluginIdentityMeta } from './PluginIdentity';
import {
  CoreFoundationPluginIcon,
  PluginProductIcon,
} from './OfficialPluginIcon';
import {
  PluginRowMetaColumns,
  PluginTelemetrySidebar,
  formatPluginVersion,
} from './PluginAttributeBadges';
import {
  PLUGIN_CATEGORY_ORDER,
  isOpenSourcePluginOrigin,
  officialListingName,
  officialListingSummary,
  officialPluginName,
  officialPluginSummary,
  pluginCanUninstall,
  pluginCategoryLabel,
  resolvePluginCategory,
  type PluginCategoryKey,
} from './officialPlugins';
import {
  errorMessage,
  pluginDetailQueryKey,
  usePluginContributionCatalog,
  useProductPluginCatalog,
  useProductPluginDetail,
} from './pluginQueries';

function usePluginControl() {
  const transport = useBackendTransport();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const catalog = useProductPluginCatalog(api);
  return { api, ...catalog };
}

function replacePlugin(
  plugins: PluginControlItem[],
  replacement: PluginControlItem
) {
  return plugins.map((plugin) =>
    plugin.id === replacement.id ? replacement : plugin
  );
}

function upsertPlugin(
  plugins: PluginControlItem[],
  replacement: PluginControlItem
) {
  return plugins.some((plugin) => plugin.id === replacement.id)
    ? replacePlugin(plugins, replacement)
    : [...plugins, replacement];
}

type PluginActivationApi = {
  setEnabled: (
    pluginId: string,
    enabled: boolean
  ) => Promise<PluginControlItem>;
  configureAgents: (
    pluginId: string,
    allAgents: boolean,
    agents: string[]
  ) => Promise<unknown>;
  configureMcp: (
    pluginId: string,
    allAgents: boolean,
    agents: string[]
  ) => Promise<unknown>;
};

async function activateInstalledPlugin(
  plugin: PluginControlItem,
  deps: {
    api: PluginActivationApi;
    supports: (capability: string) => boolean;
  }
): Promise<{ plugin: PluginControlItem; configureError?: unknown }> {
  if (plugin.enableSupported === false) {
    return { plugin };
  }
  const updated = plugin.enabled
    ? plugin
    : await deps.api.setEnabled(plugin.id, true);
  await syncMonorepoPluginRuntime(plugin.id, true);
  try {
    if (deps.supports('plugin.write')) {
      if (plugin.skills.length > 0) {
        await deps.api.configureAgents(plugin.id, true, []);
      }
      if ((plugin.mcpCount ?? plugin.mcpServers?.length ?? 0) > 0) {
        await deps.api.configureMcp(plugin.id, true, []);
      }
    }
    return { plugin: updated };
  } catch (configureError) {
    return { plugin: updated, configureError };
  }
}

function isVxpPackagePath(path: string) {
  return path.toLocaleLowerCase().endsWith('.vxp');
}

function pluginsCatalogPath(mode: PluginCatalogMode = 'installed') {
  if (mode === 'marketplace') return '/plugins?tab=marketplace';
  if (mode === 'core') return '/plugins?tab=core';
  return '/plugins';
}

export function PluginCatalogPage() {
  const { t, i18n } = useTranslation('settings');
  const isZh = i18n.language.toLowerCase().startsWith('zh');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { supports } = useBackendCapabilities();
  const { api, plugins, setPlugins, loading, refresh } = usePluginControl();
  const canInstall = supports('plugin.write');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const importingRef = useRef(false);
  const tabParam = searchParams.get('tab');
  const catalogMode: PluginCatalogMode =
    tabParam === 'marketplace'
      ? 'marketplace'
      : tabParam === 'core'
        ? 'core'
        : 'installed';
  const setCatalogMode = (mode: PluginCatalogMode) => {
    setSearchParams(
      mode === 'installed' ? {} : { tab: mode },
      { replace: true }
    );
  };
  const [marketPage, setMarketPage] = useState<CatalogPage | null>(null);
  const [marketLoading, setMarketLoading] = useState(
    () => searchParams.get('tab') === 'marketplace'
  );
  const [pendingListing, setPendingListing] = useState<CatalogListing | null>(
    null
  );
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [updates, setUpdates] = useState<PluginUpdateStatus[]>([]);
  const [replacement, setReplacement] = useState<{
    path: string;
    preview: PluginImportPreview;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    plugin: PluginControlItem;
    x: number;
    y: number;
  } | null>(null);
  const [uninstallTarget, setUninstallTarget] =
    useState<PluginControlItem | null>(null);
  const [deletePluginData, setDeletePluginData] = useState(false);

  const contextMenuItems = useMemo<ProductContextMenuItem[]>(() => {
    if (!contextMenu) return [];
    const items: ProductContextMenuItem[] = [
      {
        id: 'open-plugin',
        label: t('plugins.openPlugin'),
        onSelect: () => {
          navigate(`/plugins/${encodeURIComponent(contextMenu.plugin.id)}`);
        },
      },
    ];
    if (canInstall && pluginCanUninstall(contextMenu.plugin)) {
      items.push({
        id: 'uninstall-plugin',
        label: t('plugins.uninstall'),
        danger: true,
        onSelect: () => {
          setUninstallTarget(contextMenu.plugin);
        },
      });
    }
    return items;
  }, [contextMenu, canInstall, navigate, t]);

  useEffect(() => {
    if (catalogMode !== 'marketplace') return;
    let cancelled = false;
    setMarketLoading(true);
    void api
      .marketplaceCatalog()
      .then((page) => {
        if (!cancelled) setMarketPage(page);
      })
      .catch((error) => {
        if (!cancelled) {
          toast.error(t('plugins.marketplaceFailed'), {
            description: errorMessage(error),
          });
        }
      })
      .finally(() => {
        if (!cancelled) setMarketLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, catalogMode, t]);

  useEffect(() => {
    if (catalogMode !== 'installed' || !canInstall) return;
    void api
      .checkUpdates()
      .then((result) => setUpdates(Array.isArray(result) ? result : []))
      .catch(() => setUpdates([]));
  }, [api, canInstall, catalogMode, plugins]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return plugins;
    return plugins.filter((plugin) =>
      [
        officialPluginName(plugin.id, plugin.name, t),
        officialPluginSummary(plugin.id, plugin.description, t),
        plugin.publisher,
        plugin.id,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(needle))
    );
  }, [plugins, query, t]);

  const groupedByCategory = useMemo(() => {
    const map = new Map<PluginCategoryKey, PluginControlItem[]>();
    for (const cat of PLUGIN_CATEGORY_ORDER) {
      map.set(cat, []);
    }
    for (const item of visible) {
      const cat = resolvePluginCategory(item.id, {
        publisher: item.publisher,
        builtin: item.builtin,
      });
      const list = map.get(cat) ?? [];
      list.push(item);
      map.set(cat, list);
    }
    return PLUGIN_CATEGORY_ORDER.map((category) => ({
      category,
      items: map.get(category) ?? [],
    })).filter((group) => group.items.length > 0);
  }, [visible]);

  const applyEnabled = useCallback(
    async (plugin: PluginControlItem, enabled: boolean) => {
      const name = officialPluginName(plugin.id, plugin.name, t);
      setBusyId(plugin.id);
      try {
        if (!enabled) {
          const updated = await api.setEnabled(plugin.id, false);
          await syncMonorepoPluginRuntime(plugin.id, false);
          setPlugins((current) => replacePlugin(current, updated));
          toast.success(t('plugins.productDisabled', { name }));
          return;
        }
        const result = await activateInstalledPlugin(plugin, { api, supports });
        setPlugins((current) => replacePlugin(current, result.plugin));
        if (result.configureError) {
          toast.error(t('plugins.productEnableFailed', { name }), {
            description: errorMessage(result.configureError),
          });
          return;
        }
        toast.success(t('plugins.productEnabled', { name }));
      } catch (error) {
        toast.error(t('plugins.productEnableFailed', { name }), {
          description: errorMessage(error),
        });
      } finally {
        setBusyId(null);
      }
    },
    [api, setPlugins, supports, t]
  );

  const requestEnabled = useCallback(
    (plugin: PluginControlItem, enabled: boolean) => {
      if (!enabled) {
        void applyEnabled(plugin, false);
        return;
      }
      void applyEnabled(plugin, true);
    },
    [applyEnabled]
  );

  const listingFromPreview = useCallback(
    (path: string, preview: PluginImportPreview): CatalogListing => ({
      owner: preview.plugin.publisher ?? 'local',
      pluginName: preview.plugin.id,
      tag: preview.plugin.version,
      version: preview.plugin.version,
      displayName: preview.plugin.name,
      summary: preview.plugin.description ?? '',
      category: 'community',
      sourceKind: 'snapshot',
      homepage: path,
      hasMcp:
        (preview.plugin.mcpCount ?? preview.plugin.mcpServers?.length ?? 0) > 0,
      hasApp: (preview.plugin.appContributions?.length ?? 0) > 0,
      hasWorker: Boolean(preview.plugin.runtimes?.length),
      opens: (preview.plugin.appContributions ?? [])
        .filter((item) => item.kind === 'file_opener')
        .map((item) => item.label),
    }),
    []
  );

  const installPlugin = useCallback(
    async (path: string) => {
      if (importingRef.current) return;
      importingRef.current = true;
      setImporting(true);
      try {
        const preview = await api.previewImport(path, false, 'vibex');
        if (preview.conflict) {
          setReplacement({ path, preview });
          return;
        }
        setPendingPath(path);
        setPendingListing(listingFromPreview(path, preview));
      } catch (error) {
        toast.error(t('plugins.productImportFailed'), {
          description: errorMessage(error),
        });
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [api, listingFromPreview, t]
  );

  const replacePluginPackage = useCallback(async () => {
    if (!replacement || importingRef.current) return;
    const name = officialPluginName(
      replacement.preview.plugin.id,
      replacement.preview.plugin.name,
      t
    );
    importingRef.current = true;
    setImporting(true);
    try {
      const permissionIds = (replacement.preview.plugin.permissionDelta ?? [])
        .filter((permission) => !permission.optional)
        .map((permission) => permission.id);
      const imported = await api.import(
        replacement.path,
        false,
        'replace',
        'vibex',
        permissionIds
      );
      setReplacement(null);
      setPlugins((current) => upsertPlugin(current, imported));
      await refresh(false);
      if (imported.enableSupported !== false && !imported.enabled) {
        try {
          const { plugin: activated } = await activateInstalledPlugin(
            imported,
            { api, supports }
          );
          setPlugins((current) => upsertPlugin(current, activated));
        } catch (error) {
          toast.error(t('plugins.productEnableFailed', { name }), {
            description: errorMessage(error),
          });
        }
      }
    } catch (error) {
      toast.error(t('plugins.productImportFailed'), {
        description: errorMessage(error),
      });
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }, [api, refresh, replacement, setPlugins, supports, t]);

  const confirmMarketplaceInstall = useCallback(async () => {
    if (!pendingListing) return;
    const listing = pendingListing;
    const path = pendingPath;
    setPendingListing(null);
    setPendingPath(null);
    const id = `${listing.owner}/${listing.pluginName}`;
    const name = officialListingName(listing, t);
    setInstallingId(id);
    try {
      const already = Boolean(findInstalledPluginForListing(listing, plugins));
      const imported = path
        ? await api.import(path, false, already ? 'replace' : 'reject', 'vibex')
        : await api.marketplaceInstall(
            listing.owner,
            listing.pluginName,
            listing.tag,
            already ? 'replace' : 'reject'
          );
      setPlugins((current) => upsertPlugin(current, imported));
      await refresh(false);
      toast.success(t('plugins.productInstalled', { name }));
      try {
        const { plugin: activated } = await activateInstalledPlugin(imported, {
          api,
          supports,
        });
        setPlugins((current) => upsertPlugin(current, activated));
      } catch (error) {
        toast.error(t('plugins.productEnableFailed', { name }), {
          description: errorMessage(error),
        });
      }
    } catch (error) {
      toast.error(t('plugins.productImportFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setInstallingId(null);
    }
  }, [
    api,
    pendingListing,
    pendingPath,
    plugins,
    refresh,
    setPlugins,
    supports,
    t,
  ]);

  const addPlugin = useCallback(async () => {
    try {
      const selected = await pickHostFile({
        title: 'Select plugin package',
        extensions: ['vxp', 'zip'],
      });
      if (!selected || Array.isArray(selected)) return;
      await installPlugin(selected);
    } catch (error) {
      toast.error(t('plugins.productImportFailed'), {
        description: errorMessage(error),
      });
    }
  }, [installPlugin, t]);

  const pullGithubRepo = useCallback(
    async (repoUrl: string) => {
      return api.previewImport(repoUrl, false, 'vibex');
    },
    [api]
  );

  const confirmGithubInstall = useCallback(
    (preview: PluginImportPreview, repoUrl: string) => {
      const resolvedPath = preview.plugin.sourcePath || repoUrl;
      if (preview.conflict) {
        setReplacement({ path: resolvedPath, preview });
        return;
      }
      setPendingPath(resolvedPath);
      setPendingListing({
        ...listingFromPreview(repoUrl, preview),
        repo: repoUrl,
        sourceKind: 'github',
      });
    },
    [listingFromPreview]
  );

  const openExternalMarketplace = useCallback(async () => {
    if (supports('desktop.tauri')) {
      try {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(OFFICIAL_MARKETPLACE_WEB_URL);
        return;
      } catch {
        // Fallback to window.open below
      }
    }
    if (typeof window !== 'undefined') {
      window.open(OFFICIAL_MARKETPLACE_WEB_URL, '_blank', 'noopener,noreferrer');
    }
  }, [supports]);

  useEffect(() => {
    if (!canInstall) {
      setDropActive(false);
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | undefined;

    void import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) =>
        getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === 'enter') {
            setDropActive(
              payload.paths.length === 1 &&
                isVxpPackagePath(payload.paths[0] ?? '')
            );
            return;
          }
          if (payload.type === 'leave') {
            setDropActive(false);
            return;
          }
          if (payload.type !== 'drop') return;

          setDropActive(false);
          const path = payload.paths[0];
          if (payload.paths.length !== 1 || !path || !isVxpPackagePath(path)) {
            toast.error(t('plugins.productDropInvalid'));
            return;
          }
          void installPlugin(path);
        })
      )
      .then((stopListening) => {
        if (disposed) stopListening();
        else unlisten = stopListening;
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [canInstall, installPlugin, t]);

  const uninstallPlugin = useCallback(async () => {
    if (!uninstallTarget || !canInstall) return;
    const target = uninstallTarget;
    const name = officialPluginName(target.id, target.name, t);
    setBusyId(target.id);
    try {
      await api.uninstall(target.id, !deletePluginData);
      await syncMonorepoPluginRuntime(target.id, false);
      setUninstallTarget(null);
      setPlugins((current) =>
        current.filter((plugin) => plugin.id !== target.id)
      );
      toast.success(t('plugins.productUninstalled', { name }));
      await refresh(false);
    } catch (error) {
      toast.error(t('plugins.productUninstallFailed', { name }), {
        description: errorMessage(error),
      });
    } finally {
      setBusyId(null);
    }
  }, [
    api,
    canInstall,
    deletePluginData,
    refresh,
    setPlugins,
    t,
    uninstallTarget,
  ]);

  const renderInstalledPluginRow = (plugin: PluginControlItem) => {
    const hasWarning = (plugin.warnings?.length ?? 0) > 0;
    return (
      <div
        key={`${plugin.publisher ?? 'local'}:${plugin.id}`}
        className="product-plugin-row dsh-plugin-card"
        data-plugin-card={plugin.id}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu({
            plugin,
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        <button
          type="button"
          className="product-plugin-open"
          onClick={() => navigate(`/plugins/${encodeURIComponent(plugin.id)}`)}
        >
          <PluginProductIcon pluginId={plugin.id} />
          <span className="product-plugin-row-copy">
            <span className="product-plugin-row-title">
              <strong>{officialPluginName(plugin.id, plugin.name, t)}</strong>
              {hasWarning ? (
                <span className="dsh-status-tag" data-tone="danger">
                  {t('plugins.statusProblem')}
                </span>
              ) : null}
            </span>
            <span className="product-plugin-row-summary">
              {officialPluginSummary(plugin.id, plugin.description, t)}
            </span>
          </span>
        </button>
        <PluginRowMetaColumns
          pluginId={plugin.id}
          owner={plugin.publisher}
          version={plugin.version}
          sourceOrigin={plugin.sourceOrigin}
        />
        <span className="product-plugin-row-actions dsh-row-action-slot">
          {busyId === plugin.id ? (
            <Loader2
              className="product-plugin-row-spinner"
              aria-hidden="true"
            />
          ) : null}
          {updates.some(
            (item) => item.pluginId === plugin.id && item.updateAvailable
          ) ? (
            <Button
              type="button"
              variant="outline"
              disabled={!canInstall || busyId === plugin.id}
              onClick={() => {
                const listing: CatalogListing = {
                  owner: plugin.publisher ?? 'vibex',
                  pluginName: plugin.id,
                  tag:
                    updates.find((item) => item.pluginId === plugin.id)
                      ?.availableTag ?? plugin.version,
                  version: plugin.version,
                  displayName: plugin.name,
                  summary: plugin.description ?? '',
                  category: 'official',
                  sourceKind: plugin.sourceKind,
                  homepage: plugin.sourceOrigin,
                };
                setPendingListing(listing);
              }}
            >
              {t('plugins.updateAvailable')}
            </Button>
          ) : null}
          <Switch
            className="dsh-switch"
            aria-label={t('plugins.enableNamed', {
              name: officialPluginName(plugin.id, plugin.name, t),
            })}
            checked={plugin.enabled}
            disabled={
              busyId === plugin.id ||
              !supports('plugin.write') ||
              !plugin.enableSupported
            }
            onCheckedChange={(enabled) => requestEnabled(plugin, enabled)}
          />
        </span>
      </div>
    );
  };

  return (
    <main className="product-plugins-page dsh-plugins-page">
      <header className="product-plugins-header">
        <div className="chat-channel-heading">
          <div className="chat-channel-heading__actions">
            <PluginCatalogActions
              canAdd={canInstall}
              adding={importing}
              search={
                <label
                  className="product-plugin-search"
                  data-control-frame="single"
                >
                  <Search aria-hidden="true" />
                  <input
                    type="search"
                    className="product-plugin-search-input"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('plugins.productSearchPlaceholder')}
                    aria-label={t('plugins.productSearchPlaceholder')}
                  />
                </label>
              }
              onAdd={() => void addPlugin()}
              onPullGithubRepo={pullGithubRepo}
              onConfirmGithubInstall={confirmGithubInstall}
              onOpenExternalMarketplace={openExternalMarketplace}
            />
            <PluginCatalogModeTabs
              value={catalogMode}
              onChange={setCatalogMode}
            />
          </div>
        </div>
      </header>

      {catalogMode === 'marketplace' ? (
        <section
          className="product-plugin-catalog-body"
          aria-label={t('plugins.marketplaceTab')}
        >
          <PluginMarketplaceList
            official={marketPage?.official ?? []}
            community={marketPage?.community ?? []}
            plugins={plugins}
            query={query}
            loading={marketLoading}
            installingId={installingId}
            canInstall={canInstall}
            onInstall={setPendingListing}
          />
        </section>
      ) : catalogMode === 'core' ? (
        <section
          className="product-plugin-catalog-body product-plugin-list dsh-core-inventory-body"
          aria-label={t('plugins.coreModulesTab')}
        >
          <CoreFoundationInventoryView query={query} />
        </section>
      ) : (
        <section
          className="product-plugin-catalog-body product-plugin-list dsh-plugin-catalog-list"
          aria-busy={loading || importing}
          aria-label={t('plugins.catalogAria')}
        >
          <PluginDropOverlay active={dropActive} installing={importing} />
          {loading ? <PluginCatalogLoading /> : null}
          {!loading && groupedByCategory.length > 0 ? (
            <div className="dsh-plugin-groups">
              {groupedByCategory.map(({ category, items }) => (
                <section
                  key={category}
                  className="dsh-plugin-group"
                  data-plugin-group={category}
                >
                  <div className="dsh-plugin-group-head">
                    <h3 className="dsh-plugin-group-title">
                      {pluginCategoryLabel(category, t, isZh)}
                    </h3>
                  </div>
                  <div className="dsh-plugin-group-cards">
                    {items.map((item) => renderInstalledPluginRow(item))}
                  </div>
                </section>
              ))}
            </div>
          ) : null}
          {!loading && visible.length === 0 ? (
            <div className="product-plugin-empty">
              <Puzzle aria-hidden="true" />
              <strong>{t('plugins.productEmpty')}</strong>
              {query.trim() ? (
                <span className="product-plugin-muted">
                  {t('plugins.productEmptySearchHint')}
                </span>
              ) : (
                <Button
                  variant="outline"
                  onClick={() => setCatalogMode('marketplace')}
                >
                  {t('plugins.marketplaceTab')}
                </Button>
              )}
            </div>
          ) : null}
        </section>
      )}

      <PluginInstallTrustDialog
        listing={pendingListing}
        onCancel={() => {
          setPendingListing(null);
          setPendingPath(null);
        }}
        onConfirm={() => void confirmMarketplaceInstall()}
      />

      {contextMenu ? (
        <ProductContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          ariaLabel={officialPluginName(
            contextMenu.plugin.id,
            contextMenu.plugin.name,
            t
          )}
          onClose={() => setContextMenu(null)}
        />
      ) : null}

      <Dialog
        open={Boolean(replacement)}
        onOpenChange={(open) => !open && setReplacement(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t('plugins.importTitle', {
                name: replacement?.preview.plugin.name ?? '',
              })}
            </DialogTitle>
            <DialogDescription>
              {t('plugins.sameIdConflictDescription')}
            </DialogDescription>
          </DialogHeader>
          {replacement?.preview.conflict ? (
            <div className="plugin-import-conflict" role="alert">
              <AlertTriangle aria-hidden="true" />
              <div>
                <strong>{t('plugins.sameIdConflict')}</strong>
                <p>
                  {replacement.preview.plugin.id} · v
                  {replacement.preview.plugin.version}
                </p>
                <code>{replacement.preview.conflict.installedSource}</code>
                <p className="product-plugin-trust-warning">
                  {t('plugins.fullTrustConfirm')}
                </p>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setReplacement(null)}
              disabled={importing}
            >
              {t('plugins.keepInstalled')}
            </Button>
            <Button
              onClick={() => void replacePluginPackage()}
              disabled={importing}
            >
              {importing ? <Loader2 className="animate-spin" /> : null}
              {t('plugins.replaceInstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(uninstallTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setUninstallTarget(null);
            setDeletePluginData(false);
          }
        }}
        aria-labelledby="plugin-uninstall-title"
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle id="plugin-uninstall-title">
              {t('plugins.uninstallTitle', {
                name: uninstallTarget
                  ? officialPluginName(
                      uninstallTarget.id,
                      uninstallTarget.name,
                      t
                    )
                  : '',
              })}
            </DialogTitle>
            <DialogDescription>
              {t(
                uninstallTarget?.sourceKind === 'developer_link'
                  ? 'plugins.uninstallLinkedDescription'
                  : deletePluginData
                    ? 'plugins.uninstallDeleteDataDescription'
                    : 'plugins.uninstallDescription',
                {
                  name: uninstallTarget
                    ? officialPluginName(
                        uninstallTarget.id,
                        uninstallTarget.name,
                        t
                      )
                    : '',
                }
              )}
            </DialogDescription>
          </DialogHeader>
          {uninstallTarget?.sourceKind !== 'developer_link' ? (
            <label className="product-plugin-delete-data">
              <input
                type="checkbox"
                checked={deletePluginData}
                onChange={(event) => setDeletePluginData(event.target.checked)}
              />
              {t('plugins.deletePluginData')}
            </label>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setUninstallTarget(null)}
              disabled={busyId === uninstallTarget?.id}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void uninstallPlugin()}
              disabled={busyId === uninstallTarget?.id}
            >
              {busyId === uninstallTarget?.id ? (
                <Loader2 className="animate-spin" />
              ) : null}
              {t('plugins.confirmUninstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function CoreFoundationInventoryView({ query }: { query: string }) {
  const { i18n } = useTranslation('settings');
  const navigate = useNavigate();
  const isZh = i18n.language.toLowerCase().startsWith('zh');
  const inventory = useCoreFoundationInventory();
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return inventory;
    return inventory.filter(({ descriptor }) =>
      [
        descriptor.id,
        descriptor.packageName,
        descriptor.titleZh,
        descriptor.titleEn,
        descriptor.summaryZh,
        descriptor.summaryEn,
        ...descriptor.provides,
        ...descriptor.parts.map((part) => part.moduleName),
      ]
        .join(' ')
        .toLocaleLowerCase()
        .includes(needle)
    );
  }, [inventory, query]);

  const toggleExpand = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="dsh-plugin-groups dsh-inventory-container" data-core-inventory>
      {CORE_PLUGIN_PLANES.map((plane) => {
        const items = filtered.filter(
          (entry) => entry.descriptor.plane === plane.id
        );
        if (items.length === 0) return null;
        return (
          <section
            key={plane.id}
            className="dsh-plugin-group dsh-inventory-plane"
            data-plane={plane.id}
          >
            <div className="dsh-plugin-group-head">
              <div className="dsh-inventory-plane-title-row">
                <h3 className="dsh-plugin-group-title">
                  {isZh ? plane.titleZh : plane.titleEn}
                </h3>
                <span className="dsh-inventory-count-pill">{items.length}</span>
              </div>
            </div>
            <div className="dsh-plugin-group-cards">
              {items.map((item) => (
                <CoreFoundationRow
                  key={item.descriptor.id}
                  snapshot={item}
                  isZh={isZh}
                  expanded={expandedIds.has(item.descriptor.id)}
                  onToggle={() => toggleExpand(item.descriptor.id)}
                  onOpenSettings={
                    item.descriptor.settingsPath
                      ? () => navigate(item.descriptor.settingsPath!)
                      : undefined
                  }
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function CoreFoundationRow({
  snapshot,
  isZh,
  expanded,
  onToggle,
  onOpenSettings,
}: {
  snapshot: CorePluginRuntimeSnapshot;
  isZh: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenSettings?: () => void;
}) {
  const { descriptor, active, liveRegistrationCount } = snapshot;
  const title = isZh ? descriptor.titleZh : descriptor.titleEn;
  const summary = isZh ? descriptor.summaryZh : descriptor.summaryEn;
  return (
    <div
      className="dsh-core-item-wrap"
      data-core-plugin-id={descriptor.id}
      data-expanded={expanded ? 'true' : 'false'}
    >
      <div className="product-plugin-row dsh-plugin-card dsh-core-row">
        <button
          type="button"
          className="product-plugin-open"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          <CoreFoundationPluginIcon
            artworkKey={descriptor.artworkKey as CoreFoundationArtworkKey}
            pluginId={descriptor.id}
          />
          <span className="product-plugin-row-copy">
            <span className="product-plugin-row-title">
              <strong>{title}</strong>
              <span className="product-plugin-version">
                v{descriptor.version}
              </span>
              <code className="dsh-package-chip">{descriptor.packageName}</code>
            </span>
            <span className="product-plugin-row-summary">{summary}</span>
          </span>
        </button>
        <span className="product-plugin-row-actions">
          <span
            className="dsh-state-badge"
            data-state={active ? 'done' : 'idle'}
          >
            <span
              className="dsh-state-dot"
              data-state={active ? 'done' : 'idle'}
            />
            {isZh ? '运行中' : 'Running'}
          </span>
          <button
            type="button"
            className="dsh-core-expand-btn"
            aria-label={title}
            onClick={onToggle}
          >
            {expanded ? (
              <ChevronDown aria-hidden="true" />
            ) : (
              <ChevronRight aria-hidden="true" />
            )}
          </button>
        </span>
      </div>
      {expanded ? (
        <div className="dsh-inventory-card-details dsh-core-row-details">
          <dl className="dsh-card-facts">
            <div>
              <dt>{isZh ? '插件标识 (Entry ID)' : 'Entry ID'}</dt>
              <dd>
                <code>{descriptor.id}</code>
              </dd>
            </div>
            <div>
              <dt>{isZh ? '模块包名 (Module)' : 'Module'}</dt>
              <dd>
                <code>{descriptor.packageName}</code>
              </dd>
            </div>
            <div>
              <dt>{isZh ? '提供服务 (Provides)' : 'Provides'}</dt>
              <dd>
                <code>{descriptor.provides.join(', ')}</code>
              </dd>
            </div>
            <div>
              <dt>{isZh ? '注入依赖 (Injects)' : 'Injects'}</dt>
              <dd>
                <code>
                  {descriptor.injects.length > 0
                    ? descriptor.injects.join(', ')
                    : isZh
                      ? '无 (内核根插件)'
                      : 'None (Root plugin)'}
                </code>
              </dd>
            </div>
            <div>
              <dt>{isZh ? '已激活贡献项' : 'Active registrations'}</dt>
              <dd>{liveRegistrationCount}</dd>
            </div>
          </dl>
          <div className="dsh-inventory-parts">
            <h5>
              {isZh
                ? `拆解子模块 (${descriptor.parts.length})`
                : `Decomposed Components (${descriptor.parts.length})`}
            </h5>
            <ul className="dsh-detail-rows">
              {descriptor.parts.map((part) => (
                <li key={part.id} className="dsh-detail-row" data-plugin-row>
                  <div className="dsh-row-main">
                    <div className="dsh-row-title-line">
                      <span className="dsh-row-id">
                        {isZh ? part.titleZh : part.titleEn}
                      </span>
                      <span className="dsh-status-tag">{part.kind}</span>
                    </div>
                    <code className="dsh-row-module">{part.moduleName}</code>
                    <span className="dsh-row-desc">
                      {isZh ? part.summaryZh : part.summaryEn}
                    </span>
                  </div>
                  <span className="dsh-row-state">
                    <span className="dsh-state-dot" data-state="done" />
                    <span>{isZh ? '运行中' : 'Running'}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {onOpenSettings ? (
            <div className="dsh-inventory-card-footer">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onOpenSettings}
              >
                <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
                {isZh ? '前往关联设置面板' : 'Open Settings Panel'}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function PluginDetailPage() {
  const { pluginId = '' } = useParams();
  const decodedId = decodeURIComponent(pluginId);
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const transport = useBackendTransport();
  const { supports } = useBackendCapabilities();
  const queryClient = useQueryClient();
  const { api, plugins, loading } = usePluginControl();
  const plugin = plugins.find((candidate) => candidate.id === decodedId);
  const detailQuery = useProductPluginDetail(api, decodedId);
  const contributionsQuery = usePluginContributionCatalog(api);
  const [tab, setTab] = useState<PluginInspectTab>('readme');
  const [openedTabs, setOpenedTabs] = useState<Set<PluginInspectTab>>(
    () => new Set(['readme'])
  );
  const showTree = isOpenSourcePluginOrigin(plugin ?? {});
  const inspectTabs: PluginInspectTab[] = showTree
    ? ['readme', 'contents', 'tree', 'config']
    : ['readme', 'contents', 'config'];
  const detail = detailQuery.data ?? null;
  const contributions = contributionsQuery.data ?? null;
  const appSurfaceTransport = useMemo(
    () => createBackendAppSurfaceTransport(transport),
    [transport]
  );

  const openTab = (next: PluginInspectTab) => {
    setTab(next);
    setOpenedTabs((current) => {
      if (current.has(next)) return current;
      const nextTabs = new Set(current);
      nextTabs.add(next);
      return nextTabs;
    });
  };

  if (!plugin && !loading) {
    return (
      <main className="product-plugins-page">
        <Button variant="ghost" size="sm" onClick={() => navigate('/plugins')}>
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          {t('plugins.backToPlugins')}
        </Button>
        <div className="product-plugin-empty">
          <strong>{t('plugins.productNotFound')}</strong>
        </div>
      </main>
    );
  }

  return (
    <main className="product-plugins-page product-plugin-detail-page dsh-detail-page">
      <div className="product-plugin-detail-nav">
        <Button variant="ghost" size="sm" onClick={() => navigate('/plugins')}>
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          {t('plugins.backToPlugins')}
        </Button>
      </div>
      {plugin && detail ? (
        <>
          <header className="product-plugin-detail-header dsh-detail-header">
            <div className="product-plugin-detail-identity">
              <PluginProductIcon pluginId={plugin.id} />
              <div className="product-plugin-detail-copy">
                <div className="product-plugin-detail-title-row">
                  <h1>{officialPluginName(plugin.id, plugin.name, t)}</h1>
                  <PluginIdentityMeta plugin={plugin} />
                </div>
                <code className="dsh-detail-package-id" data-plugin-name>
                  {plugin.id}
                </code>
                <p>
                  {officialPluginSummary(
                    plugin.id,
                    detail.summary ?? plugin.description,
                    t
                  )}
                </p>
              </div>
            </div>
          </header>
          <PluginInspectTabs
            value={tab}
            tabs={inspectTabs}
            onChange={openTab}
          />

          <div
            className="dsh-detail-split-layout"
            data-has-sidebar={showTree ? 'true' : 'false'}
          >
            <div className="dsh-detail-main-col">
              {tab === 'readme' ? (
                <>
                  <PluginReadmeView
                    pluginId={decodedId}
                    readme={detail.readme}
                  />
                  <PluginDetailDshSourceSection plugin={plugin} />
                </>
              ) : null}

              {tab === 'contents' ? (
                <PluginContentsView
                  contents={detail.contents}
                  pluginId={plugin.id}
                  owner={plugin.publisher}
                  plugin={plugin}
                  contributions={contributions?.items}
                />
              ) : null}

              {tab === 'tree' && showTree ? (
                <PluginPackageTree
                  contents={detail.contents}
                  pluginId={plugin.id}
                  owner={plugin.publisher}
                  sourceOrigin={plugin.sourceOrigin}
                />
              ) : null}

              {openedTabs.has('config') ? (
                <div
                  className="product-plugin-detail-body"
                  hidden={tab !== 'config'}
                >
                  <PluginDetailConfig
                    plugin={plugin}
                    pluginId={decodedId}
                    detail={detail}
                    contributions={contributions}
                    canSurface={supports('plugin.surface')}
                    transport={appSurfaceTransport}
                    onSaved={(updated) => {
                      queryClient.setQueryData(
                        pluginDetailQueryKey(decodedId),
                        updated
                      );
                    }}
                  />
                </div>
              ) : null}
            </div>
            {showTree ? (
              <PluginTelemetrySidebar
                pluginId={plugin.id}
                owner={plugin.publisher}
                version={plugin.version}
                sourceOrigin={plugin.sourceOrigin}
              />
            ) : null}
          </div>
        </>
      ) : (
        <PluginDetailLoading />
      )}
    </main>
  );
}

function PluginDetailDshSourceSection({
  plugin,
}: {
  plugin: PluginControlItem;
}) {
  const { t } = useTranslation('settings');
  const sourceValue =
    plugin.sourceOrigin ??
    plugin.sourcePath ??
    t(`plugins.sourceKind.${plugin.sourceKind}`, {
      defaultValue: plugin.sourceKind,
    });
  return (
    <section className="dsh-detail-section" data-plugin-source>
      <div className="dsh-section-head">
        <h4 className="dsh-section-title">{t('plugins.sourceSectionTitle')}</h4>
      </div>
      <dl className="dsh-detail-facts">
        <div>
          <dt>{t('plugins.packageIdLabel')}</dt>
          <dd>
            <code>{plugin.id}</code>
          </dd>
        </div>
        <div>
          <dt>{t('plugins.currentVersionLabel')}</dt>
          <dd>{plugin.version}</dd>
        </div>
        <div>
          <dt>{t('plugins.publisherLabel')}</dt>
          <dd>{plugin.publisher ?? 'vibex'}</dd>
        </div>
        <div>
          <dt>{t('plugins.codeSourceLabel')}</dt>
          <dd>
            <code>{sourceValue}</code>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function PluginDetailConfig({
  plugin,
  pluginId,
  detail,
  contributions,
  canSurface,
  transport,
  onSaved,
}: {
  plugin: PluginControlItem;
  pluginId: string;
  detail: PluginProductDetail;
  contributions: PluginContributionCatalog | null;
  canSurface: boolean;
  transport: ReturnType<typeof createBackendAppSurfaceTransport>;
  onSaved: (detail: PluginProductDetail) => void;
}) {
  const surfaces = plugin
    ? appSurfaceDescriptors(plugin, contributions?.items ?? [])
    : [];
  if (canSurface && surfaces.length > 0) {
    return (
      <div className="product-plugin-config-surfaces">
        {surfaces.map((surface) => (
          <AppSurfaceHost
            key={`${surface.surfaceId}:${surface.generation}`}
            descriptor={surface}
            enabled={plugin.enabled}
            transport={transport}
          />
        ))}
      </div>
    );
  }
  return (
    <PluginConfigForm pluginId={pluginId} detail={detail} onSaved={onSaved} />
  );
}

export function MarketplacePluginDetailPage() {
  const { owner = '', pluginName = '' } = useParams();
  const decodedOwner = decodeURIComponent(owner);
  const decodedName = decodeURIComponent(pluginName);
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const { supports } = useBackendCapabilities();
  const { api, plugins, setPlugins, refresh } = usePluginControl();
  const canInstall = supports('plugin.write');
  const [pendingListing, setPendingListing] = useState<CatalogListing | null>(
    null
  );
  const [installing, setInstalling] = useState(false);
  const [tab, setTab] = useState<PluginInspectTab>('readme');
  const query = useQuery({
    queryKey: ['plugin-marketplace-listing', decodedOwner, decodedName],
    queryFn: () => api.marketplaceListing(decodedOwner, decodedName),
    enabled: Boolean(decodedOwner && decodedName),
    retry: false,
  });
  const market = query.data ?? null;
  const installed = findInstalledPluginForListing(
    {
      owner: decodedOwner,
      pluginName: decodedName,
      offlinePluginId: market?.listing.offlinePluginId,
    },
    plugins
  );

  const confirmInstall = async () => {
    if (!pendingListing) return;
    const listing = pendingListing;
    const name = officialListingName(listing, t);
    setPendingListing(null);
    setInstalling(true);
    try {
      const imported = await api.marketplaceInstall(
        listing.owner,
        listing.pluginName,
        listing.tag,
        installed ? 'replace' : 'reject'
      );
      setPlugins((current) => upsertPlugin(current, imported));
      await refresh(false);
      toast.success(t('plugins.productInstalled', { name }));
      try {
        const { plugin: activated } = await activateInstalledPlugin(imported, {
          api,
          supports,
        });
        setPlugins((current) => upsertPlugin(current, activated));
      } catch (error) {
        toast.error(t('plugins.productEnableFailed', { name }), {
          description: errorMessage(error),
        });
      }
      navigate(`/plugins/${encodeURIComponent(imported.id)}`);
    } catch (error) {
      toast.error(t('plugins.productImportFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setInstalling(false);
    }
  };

  if (query.isError) {
    return (
      <main className="product-plugins-page">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(pluginsCatalogPath('marketplace'))}
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          {t('plugins.backToPlugins')}
        </Button>
        <div className="product-plugin-empty">
          <strong>{t('plugins.productNotFound')}</strong>
        </div>
      </main>
    );
  }

  if (!market) {
    return (
      <main className="product-plugins-page product-plugin-detail-page">
        <PluginDetailLoading />
      </main>
    );
  }

  const showTree = isOpenSourcePluginOrigin(market.listing);
  const inspectTabs: PluginInspectTab[] = showTree
    ? ['readme', 'contents', 'tree']
    : ['readme', 'contents'];
  const pluginId = market.listing.offlinePluginId ?? market.listing.pluginName;

  return (
    <main className="product-plugins-page product-plugin-detail-page dsh-detail-page">
      <div className="product-plugin-detail-nav">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(pluginsCatalogPath('marketplace'))}
        >
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          {t('plugins.backToPlugins')}
        </Button>
      </div>
      <header className="product-plugin-detail-header dsh-detail-header">
        <div className="product-plugin-detail-identity">
          <PluginProductIcon pluginId={pluginId} />
          <div className="product-plugin-detail-copy">
            <div className="product-plugin-detail-title-row">
              <h1>{officialListingName(market.listing, t)}</h1>
              <span className="product-plugin-version">
                {formatPluginVersion(
                  market.listing.version,
                  market.listing.tag
                )}
              </span>
            </div>
            <p>{officialListingSummary(market.listing, t)}</p>
          </div>
        </div>
        {installed ? (
          <span className="product-plugin-installed">
            {t('plugins.installedStatus')}
          </span>
        ) : canInstall ? (
          <Button
            type="button"
            disabled={installing}
            onClick={() => setPendingListing(market.listing)}
          >
            {installing ? t('plugins.installingPlugin') : t('plugins.install')}
          </Button>
        ) : null}
      </header>
      <PluginInspectTabs value={tab} tabs={inspectTabs} onChange={setTab} />
      <div
        className="dsh-detail-split-layout"
        data-has-sidebar={showTree ? 'true' : 'false'}
      >
        <div className="dsh-detail-main-col">
          {tab === 'readme' ? (
            <PluginReadmeView pluginId={pluginId} readme={market.readme} />
          ) : null}
          {tab === 'contents' ? (
            <PluginContentsView
              contents={market.contents}
              pluginId={pluginId}
              owner={market.listing.owner}
              plugin={installed}
              listing={market.listing}
              preferOfficialCatalog
            />
          ) : null}
          {tab === 'tree' && showTree ? (
            <PluginPackageTree
              contents={market.contents}
              pluginId={pluginId}
              owner={market.listing.owner}
              homepage={market.listing.homepage}
              repo={market.listing.repo}
            />
          ) : null}
        </div>
        {showTree ? (
          <PluginTelemetrySidebar
            pluginId={pluginId}
            owner={market.listing.owner}
            version={market.listing.version}
            tag={market.listing.tag}
            homepage={market.listing.homepage}
            repo={market.listing.repo}
            stars={market.listing.stars}
          />
        ) : null}
      </div>
      <PluginInstallTrustDialog
        listing={pendingListing}
        onCancel={() => setPendingListing(null)}
        onConfirm={() => void confirmInstall()}
      />
    </main>
  );
}

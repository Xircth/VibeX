import { useQueryClient } from '@tanstack/react-query';
import { open } from '@tauri-apps/plugin-dialog';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Loader2,
  Puzzle,
  Search,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';

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
import {
  appSurfaceDescriptors,
  createBackendAppSurfaceTransport,
} from '@/lib/api/appSurfaceTransport';
import {
  createPluginControlApi,
  type PluginContributionCatalog,
  type PluginControlItem,
  type PluginDevConnection,
  type PluginImportPreview,
  type PluginProductDetail,
} from '@/lib/api/plugins';
import { useBackendCapabilities, useBackendTransport } from '@/lib/transport';
import {
  PluginCatalogActions,
  PluginCatalogLoading,
  PluginDetailLoading,
  PluginDevelopmentDialog,
  PluginDropOverlay,
} from './PluginCatalogControls';
import { PluginConfigForm } from './PluginConfigForm';
import { PluginContentBrowser } from './PluginContentBrowser';
import { PluginDetailTabs, type PluginDetailTab } from './PluginDetailTabs';
import { PluginIdentityMeta } from './PluginIdentity';
import { PluginProductIcon } from './OfficialPluginIcon';
import {
  officialPluginName,
  officialPluginSummary,
  pluginCanUninstall,
  PLUGIN_DEVELOPMENT_PLUGIN_ID,
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

function isVxpPackagePath(path: string) {
  return path.toLocaleLowerCase().endsWith('.vxp');
}

export function PluginCatalogPage() {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const { supports } = useBackendCapabilities();
  const { api, plugins, setPlugins, loading, refresh } = usePluginControl();
  const canInstall = supports('plugin.write');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const importingRef = useRef(false);
  const [devConnection, setDevConnection] =
    useState<PluginDevConnection | null>(null);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
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

  const contextMenuStyle = useMemo(() => {
    if (!contextMenu || typeof window === 'undefined') return null;
    return {
      left: Math.max(12, Math.min(contextMenu.x, window.innerWidth - 180)),
      top: Math.max(12, Math.min(contextMenu.y, window.innerHeight - 96)),
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('click', closeMenu);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', closeMenu);
      window.removeEventListener('blur', closeMenu);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!supports('desktop.tauri')) return;
    void api
      .devConnection()
      .then(setDevConnection)
      .catch(() => setDevConnection(null));
  }, [api, supports]);

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

  const applyEnabled = useCallback(
    async (plugin: PluginControlItem, enabled: boolean) => {
      setBusyId(plugin.id);
      try {
        const updated = await api.setEnabled(plugin.id, enabled);
        if (enabled && supports('desktop.tauri')) {
          if (plugin.skills.length > 0) {
            await api.configureAgents(plugin.id, true, []);
          }
          if ((plugin.mcpCount ?? plugin.mcpServers?.length ?? 0) > 0) {
            await api.configureMcp(plugin.id, true, []);
          }
        }
        setPlugins((current) => replacePlugin(current, updated));
        toast.success(
          t(enabled ? 'plugins.productEnabled' : 'plugins.productDisabled', {
            name: officialPluginName(plugin.id, plugin.name, t),
          })
        );
      } catch (error) {
        toast.error(
          t('plugins.productEnableFailed', {
            name: officialPluginName(plugin.id, plugin.name, t),
          }),
          {
            description: errorMessage(error),
          }
        );
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
        const imported = await api.import(path, false, 'reject', 'vibex');
        setPlugins((current) => upsertPlugin(current, imported));
        await applyEnabled(imported, true);
        await refresh(false);
      } catch (error) {
        toast.error(t('plugins.productImportFailed'), {
          description: errorMessage(error),
        });
      } finally {
        importingRef.current = false;
        setImporting(false);
      }
    },
    [api, applyEnabled, refresh, setPlugins, t]
  );

  const replacePluginPackage = useCallback(async () => {
    if (!replacement || importingRef.current) return;
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
      await applyEnabled(imported, true);
      await refresh(false);
    } catch (error) {
      toast.error(t('plugins.productImportFailed'), {
        description: errorMessage(error),
      });
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }, [api, applyEnabled, refresh, replacement, setPlugins, t]);

  const addPlugin = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'VibeX Plugin', extensions: ['vxp', 'zip'] }],
      });
      if (!selected || Array.isArray(selected)) return;
      await installPlugin(selected);
    } catch (error) {
      toast.error(t('plugins.productImportFailed'), {
        description: errorMessage(error),
      });
    }
  }, [installPlugin, t]);

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
      await api.uninstall(target.id);
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
  }, [api, canInstall, refresh, setPlugins, t, uninstallTarget]);

  return (
    <main className="product-plugins-page">
      <header className="product-plugins-header">
        <div className="product-plugins-heading">
          <h1>
            <Puzzle aria-hidden="true" />
            <span>{t('plugins.productTitle')}</span>
          </h1>
          <p>{t('plugins.productSubtitle')}</p>
        </div>
        <PluginCatalogActions
          canDevelop={supports('desktop.tauri')}
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
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('plugins.productSearchPlaceholder')}
                aria-label={t('plugins.productSearchPlaceholder')}
              />
            </label>
          }
          onOpenDevelopment={() => setDevToolsOpen(true)}
          onAdd={() => void addPlugin()}
        />
      </header>

      <section
        className="product-plugin-list settings-surface"
        aria-busy={loading || importing}
        aria-label={t('plugins.catalogAria')}
      >
        <PluginDropOverlay active={dropActive} installing={importing} />
        {loading ? <PluginCatalogLoading /> : null}
        {!loading
          ? visible.map((plugin) => (
              <div
                key={`${plugin.publisher ?? 'local'}:${plugin.id}`}
                className="product-plugin-row"
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
                  onClick={() =>
                    navigate(`/plugins/${encodeURIComponent(plugin.id)}`)
                  }
                >
                  <PluginProductIcon pluginId={plugin.id} />
                  <span className="product-plugin-row-copy">
                    <span className="product-plugin-row-title">
                      <strong>
                        {officialPluginName(plugin.id, plugin.name, t)}
                      </strong>
                      <PluginIdentityMeta plugin={plugin} />
                    </span>
                    <span className="product-plugin-row-summary">
                      {officialPluginSummary(plugin.id, plugin.description, t)}
                    </span>
                  </span>
                  <ChevronRight aria-hidden="true" />
                </button>
                <span className="product-plugin-row-actions">
                  {busyId === plugin.id ? (
                    <Loader2
                      className="product-plugin-row-spinner"
                      aria-hidden="true"
                    />
                  ) : null}
                  <Switch
                    aria-label={t('plugins.enableNamed', {
                      name: officialPluginName(plugin.id, plugin.name, t),
                    })}
                    checked={plugin.enabled}
                    disabled={
                      busyId === plugin.id ||
                      !supports('plugin.write') ||
                      !plugin.enableSupported
                    }
                    onCheckedChange={(enabled) =>
                      requestEnabled(plugin, enabled)
                    }
                  />
                </span>
              </div>
            ))
          : null}
        {!loading && visible.length === 0 ? (
          <div className="product-plugin-empty">
            <Puzzle aria-hidden="true" />
            <strong>{t('plugins.productEmpty')}</strong>
            <span className="product-plugin-muted">
              {query
                ? t('plugins.productEmptySearchHint')
                : t('plugins.productEmptyHint')}
            </span>
            {!query ? (
              <Button variant="outline" onClick={() => void refresh()}>
                {t('common:retry')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>

      {contextMenu && contextMenuStyle ? (
        <div
          className="product-plugin-context-menu tahoe-popover"
          role="menu"
          aria-label={officialPluginName(
            contextMenu.plugin.id,
            contextMenu.plugin.name,
            t
          )}
          style={contextMenuStyle}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.preventDefault()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const pluginId = contextMenu.plugin.id;
              setContextMenu(null);
              navigate(`/plugins/${encodeURIComponent(pluginId)}`);
            }}
          >
            {t('plugins.openPlugin')}
          </button>
          {canInstall && pluginCanUninstall(contextMenu.plugin) ? (
            <button
              type="button"
              role="menuitem"
              className="is-destructive"
              onClick={() => {
                setUninstallTarget(contextMenu.plugin);
                setContextMenu(null);
              }}
            >
              {t('plugins.uninstall')}
            </button>
          ) : null}
        </div>
      ) : null}

      <PluginDevelopmentDialog
        open={devToolsOpen}
        connection={devConnection}
        onOpenChange={setDevToolsOpen}
        onOpenPlugin={() =>
          navigate(
            `/plugins/${encodeURIComponent(PLUGIN_DEVELOPMENT_PLUGIN_ID)}`
          )
        }
      />

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
        onOpenChange={(open) => !open && setUninstallTarget(null)}
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
              {t('plugins.uninstallDescription', {
                name: uninstallTarget
                  ? officialPluginName(
                      uninstallTarget.id,
                      uninstallTarget.name,
                      t
                    )
                  : '',
              })}
            </DialogDescription>
          </DialogHeader>
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
  const [tab, setTab] = useState<PluginDetailTab>('config');
  const [openedTabs, setOpenedTabs] = useState<Set<PluginDetailTab>>(
    () => new Set(['config'])
  );
  const detail = detailQuery.data ?? null;
  const contributions = contributionsQuery.data ?? null;
  const appSurfaceTransport = useMemo(
    () => createBackendAppSurfaceTransport(transport),
    [transport]
  );

  const openTab = (next: PluginDetailTab) => {
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
    <main className="product-plugins-page product-plugin-detail-page">
      <div className="product-plugin-detail-nav">
        <Button variant="ghost" size="sm" onClick={() => navigate('/plugins')}>
          <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
          {t('plugins.backToPlugins')}
        </Button>
      </div>
      {plugin && detail ? (
        <>
          <header className="product-plugin-detail-header">
            <div className="product-plugin-detail-identity">
              <PluginProductIcon pluginId={plugin.id} />
              <div className="product-plugin-detail-copy">
                <div className="product-plugin-detail-title-row">
                  <h1>{officialPluginName(plugin.id, plugin.name, t)}</h1>
                  <PluginIdentityMeta plugin={plugin} />
                </div>
                <p>
                  {officialPluginSummary(
                    plugin.id,
                    detail.summary ?? plugin.description,
                    t
                  )}
                </p>
              </div>
            </div>
            <PluginDetailTabs value={tab} onChange={openTab} />
          </header>

          {openedTabs.has('content') ? (
            <div hidden={tab !== 'content'}>
              <PluginContentBrowser pluginId={decodedId} detail={detail} />
            </div>
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
        </>
      ) : (
        <PluginDetailLoading />
      )}
    </main>
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

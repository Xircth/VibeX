import { open } from '@tauri-apps/plugin-dialog';
import { ArrowLeft, ChevronRight, Loader2, Puzzle, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import {
  createPluginControlApi,
  type PluginControlItem,
  type PluginDevConnection,
  type PluginProductDetail,
} from '@/lib/api/plugins';
import { useBackendCapabilities, useBackendTransport } from '@/lib/transport';
import {
  PluginCatalogActions,
  PluginCatalogLoading,
  PluginDetailLoading,
  PluginDevelopmentDialog,
} from './PluginCatalogControls';
import { PluginConfigForm } from './PluginConfigForm';
import { PluginContentBrowser } from './PluginContentBrowser';
import { PluginDetailTabs, type PluginDetailTab } from './PluginDetailTabs';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isProductPlugin(plugin: PluginControlItem) {
  return !['codex_native', 'claude_code_native'].includes(plugin.sourceKind);
}

function PluginIcon() {
  return (
    <span className="product-plugin-icon" aria-hidden="true">
      <Puzzle />
    </span>
  );
}

function PluginMetadataBadges({
  publisher,
  version,
}: {
  publisher: string;
  version: string;
}) {
  const { t } = useTranslation('settings');

  return (
    <div
      className="product-plugin-detail-metadata"
      role="group"
      aria-label={t('plugins.productMetadata')}
    >
      <Badge
        variant="secondary"
        className="product-plugin-metadata-badge"
        title={t('plugins.sourceTitle')}
      >
        {publisher}
      </Badge>
      <Badge
        variant="outline"
        className="product-plugin-metadata-badge"
        title={t('plugins.versionTitle')}
      >
        v{version}
      </Badge>
    </div>
  );
}

function useProductPlugins() {
  const { t } = useTranslation('settings');
  const transport = useBackendTransport();
  const api = useMemo(() => createPluginControlApi(transport), [transport]);
  const [plugins, setPlugins] = useState<PluginControlItem[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const catalog = await api.catalog();
      setPlugins(catalog.plugins.filter(isProductPlugin));
    } catch (error) {
      toast.error(t('plugins.productCatalogFailed'), {
        description: errorMessage(error),
      });
    } finally {
      setLoading(false);
    }
  }, [api, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { api, plugins, setPlugins, loading, refresh };
}

function replacePlugin(
  plugins: PluginControlItem[],
  replacement: PluginControlItem
) {
  return plugins.map((plugin) =>
    plugin.id === replacement.id ? replacement : plugin
  );
}

export function PluginCatalogPage() {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const { supports } = useBackendCapabilities();
  const { api, plugins, setPlugins, loading, refresh } = useProductPlugins();
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [devConnection, setDevConnection] =
    useState<PluginDevConnection | null>(null);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [devConnectionCopied, setDevConnectionCopied] = useState(false);

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
      [plugin.name, plugin.description, plugin.publisher, plugin.id]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase().includes(needle))
    );
  }, [plugins, query]);

  const applyEnabled = useCallback(
    async (plugin: PluginControlItem, enabled: boolean) => {
      setBusyId(plugin.id);
      try {
        const updated = await api.setEnabled(plugin.id, enabled);
        if (enabled && plugin.skills.length > 0 && supports('desktop.tauri')) {
          await api.configureAgents(plugin.id, true, []);
        }
        setPlugins((current) => replacePlugin(current, updated));
        toast.success(
          t(enabled ? 'plugins.productEnabled' : 'plugins.productDisabled', {
            name: plugin.name,
          })
        );
      } catch (error) {
        toast.error(t('plugins.productEnableFailed', { name: plugin.name }), {
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

  const addPlugin = useCallback(async () => {
    try {
      const selected = await open({
        multiple: false,
        directory: false,
        filters: [{ name: 'VibeX Plugin', extensions: ['vxp', 'zip'] }],
      });
      if (!selected || Array.isArray(selected)) return;
      const preview = await api.previewImport(selected, false, 'vibex');
      if (preview.conflict) {
        toast.warning(
          t('plugins.productAlreadyInstalled', {
            name: preview.plugin.name,
          })
        );
        return;
      }
      const imported = await api.import(selected, false, 'reject', 'vibex');
      setPlugins((current) => [...current, imported]);
      await applyEnabled(imported, true);
    } catch (error) {
      toast.error(t('plugins.productImportFailed'), {
        description: errorMessage(error),
      });
    }
  }, [api, applyEnabled, setPlugins, t]);

  const copyDevConnection = useCallback(async () => {
    if (!devConnection) return;
    try {
      await navigator.clipboard.writeText(
        [
          `export VIBEX_PLUGIN_DEV_HOST='${devConnection.endpoint}'`,
          `export VIBEX_PLUGIN_DEV_TOKEN='${devConnection.token}'`,
        ].join('\n')
      );
      setDevConnectionCopied(true);
      toast.success(t('plugins.devConnectionCopied'));
    } catch (error) {
      toast.error(t('plugins.devConnectionCopyFailed'), {
        description: errorMessage(error),
      });
    }
  }, [devConnection, t]);

  return (
    <main className="product-plugins-page">
      <header className="product-plugins-header">
        <div className="product-plugins-heading">
          <h1>{t('plugins.productTitle')}</h1>
          <p>{t('plugins.productSubtitle')}</p>
        </div>
        <PluginCatalogActions
          canDevelop={supports('desktop.tauri')}
          canAdd={supports('plugin.write') && supports('desktop.tauri')}
          devReady={Boolean(devConnection)}
          onOpenDevelopment={() => setDevToolsOpen(true)}
          onAdd={() => void addPlugin()}
        />
      </header>

      <div className="product-plugin-toolbar">
        <span className="product-plugin-count">
          {t('plugins.installedCount', { count: visible.length })}
        </span>
        <label className="product-plugin-search" data-control-frame="single">
          <Search aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('plugins.productSearchPlaceholder')}
            aria-label={t('plugins.productSearchPlaceholder')}
          />
        </label>
      </div>

      <section
        className="product-plugin-list settings-surface"
        aria-busy={loading}
        aria-label={t('plugins.catalogAria')}
      >
        {loading ? <PluginCatalogLoading /> : null}
        {!loading
          ? visible.map((plugin) => (
              <div
                key={`${plugin.publisher ?? 'local'}:${plugin.id}`}
                className="product-plugin-row"
              >
                <button
                  type="button"
                  className="product-plugin-open"
                  onClick={() =>
                    navigate(`/plugins/${encodeURIComponent(plugin.id)}`)
                  }
                >
                  <PluginIcon />
                  <span className="product-plugin-row-copy">
                    <span className="product-plugin-row-title">
                      <strong>{plugin.name}</strong>
                      <small>
                        {plugin.publisher ?? t('plugins.localPublisher')} · v
                        {plugin.version}
                      </small>
                    </span>
                    <span>{plugin.description ?? t('plugins.noSummary')}</span>
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
                      name: plugin.name,
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

      <PluginDevelopmentDialog
        open={devToolsOpen}
        connection={devConnection}
        copied={devConnectionCopied}
        onOpenChange={setDevToolsOpen}
        onCopy={() => void copyDevConnection()}
      />
    </main>
  );
}

export function PluginDetailPage() {
  const { pluginId = '' } = useParams();
  const decodedId = decodeURIComponent(pluginId);
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const { api, plugins, loading } = useProductPlugins();
  const plugin = plugins.find((candidate) => candidate.id === decodedId);
  const [detail, setDetail] = useState<PluginProductDetail | null>(null);
  const [tab, setTab] = useState<PluginDetailTab>('content');

  useEffect(() => {
    if (!decodedId) return;
    void api
      .productDetail(decodedId)
      .then(setDetail)
      .catch((error) => {
        toast.error(t('plugins.productDetailFailed'), {
          description: errorMessage(error),
        });
      });
  }, [api, decodedId, t]);

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
              <PluginIcon />
              <div className="product-plugin-detail-copy">
                <div className="product-plugin-detail-title-row">
                  <h1>{plugin.name}</h1>
                  <PluginMetadataBadges
                    publisher={plugin.publisher ?? t('plugins.localPublisher')}
                    version={plugin.version}
                  />
                </div>
                <p>{detail.summary ?? plugin.description}</p>
              </div>
            </div>
            <PluginDetailTabs value={tab} onChange={setTab} />
          </header>

          {tab === 'content' ? <PluginContentBrowser detail={detail} /> : null}

          {tab === 'config' ? (
            <PluginConfigForm
              pluginId={decodedId}
              detail={detail}
              onSaved={setDetail}
            />
          ) : null}
        </>
      ) : (
        <PluginDetailLoading />
      )}
    </main>
  );
}

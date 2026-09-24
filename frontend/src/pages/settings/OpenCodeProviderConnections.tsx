import {
  ArrowLeft,
  Check,
  Database,
  ExternalLink,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentId,
  AgentModelProviderImportPreviewView,
  OpenCodeCatalogProviderView,
  OpenCodeProviderCatalogSource,
  OpenCodeProviderCatalogView,
  OpenCodeProviderConnectionView,
  OpenCodeProviderConnectionsView,
  OpenCodeProviderModelRequest,
} from 'shared/types';

import { createPortal } from 'react-dom';

import { AstryxSelect, getMenuPosition } from '@/components/ui/astryx-select';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { usePortalContainer } from '@/contexts/PortalContainerContext';
import { NativeSurfaceOcclusionHold } from '@/contexts/WorkspaceOverlayContext';
import { cn } from '@/lib/utils';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

import type { ProviderCatalogTemplateView } from './providerCatalogTypes';
import { useProviderCatalogList } from './useProviderCatalogList';

const PROVIDER_PACKAGES = [
  ['@ai-sdk/openai-compatible', 'OpenAI Compatible'],
  ['@ai-sdk/openai', 'OpenAI'],
  ['@ai-sdk/anthropic', 'Anthropic'],
  ['@ai-sdk/google', 'Google'],
  ['@ai-sdk/cerebras', 'Cerebras'],
  ['@ai-sdk/xai', 'xAI'],
  ['@ai-sdk/azure', 'Azure OpenAI'],
  ['@ai-sdk/amazon-bedrock', 'Amazon Bedrock'],
  ['@ai-sdk/google-vertex', 'Google Vertex AI'],
  ['@ai-sdk/deepseek', 'DeepSeek'],
] as const;

type OpenCodeProviderSurface = 'all' | 'go' | 'official' | 'provider';
type Page = 'list' | 'form';

type Props = {
  agentId?: AgentId;
  onChanged?: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  surface?: OpenCodeProviderSurface;
};

export function openCodeProviderSurface(
  providerId: string
): Exclude<OpenCodeProviderSurface, 'all'> {
  if (providerId === 'opencode-go' || providerId === 'opencode') return 'go';
  return 'provider';
}

function matchesOpenCodeSurface(
  providerId: string,
  surface: OpenCodeProviderSurface
) {
  if (surface === 'all') return true;
  return openCodeProviderSurface(providerId) === surface;
}

type ProviderModelDraft = OpenCodeProviderModelRequest;

function pluginCatalogRows(
  templates: ProviderCatalogTemplateView[],
  query: string
): ProviderCatalogTemplateView[] {
  const rows = templates.filter((template) => template.surface === 'opencode');
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((template) =>
    [template.name, template.provider_id, template.npm, template.base_url].some(
      (value) => value != null && value.toLowerCase().includes(needle)
    )
  );
}

export function OpenCodeProviderConnections({
  agentId = 'opencode',
  onChanged,
  onDirtyChange,
  surface = 'all',
}: Props) {
  const { t } = useTranslation(['settings', 'common']);
  const [view, setView] = useState<OpenCodeProviderConnectionsView | null>(
    null
  );
  const [catalog, setCatalog] = useState<OpenCodeProviderCatalogView | null>(
    null
  );
  const [page, setPage] = useState<Page>('list');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogOpen, setCatalogOpen] = useState(false);
  const catalogRef = useRef<HTMLDivElement>(null);
  const catalogTriggerRef = useRef<HTMLDivElement>(null);
  const catalogMenuRef = useRef<HTMLDivElement>(null);
  const [catalogMenuPosition, setCatalogMenuPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  const portalContainer = usePortalContainer();
  const [providerId, setProviderId] = useState('');
  const [name, setName] = useState('');
  const [npm, setNpm] = useState('');
  const [api, setApi] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ProviderModelDraft[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const formDirty = Boolean(
    providerId || name || npm || api || baseUrl || apiKey || models.length
  );
  const existingProvider = view?.providers.find(
    (provider) => provider.provider_id === providerId.trim().toLowerCase()
  );
  const credentialRequired = !existingProvider?.credential_present;
  const lockOfficialEndpoint = surface === 'official' || surface === 'go';
  const allowCreate = surface !== 'go';
  const allowImport = surface === 'provider';
  const pluginCatalogEnabled = surface === 'provider';
  const { catalog: pluginCatalog, catalogError: pluginCatalogError } =
    useProviderCatalogList(agentId, pluginCatalogEnabled);
  const [importPreview, setImportPreview] =
    useState<AgentModelProviderImportPreviewView | null>(null);
  const [importSelected, setImportSelected] = useState<string[]>([]);

  useEffect(() => {
    onDirtyChange?.(page === 'form' && formDirty);
    return () => onDirtyChange?.(false);
  }, [formDirty, onDirtyChange, page]);

  const loadConnections = useCallback(async () => {
    setLoading(true);
    setConnectionError(null);
    try {
      setView(await agentManagementApi.openCodeProviders(agentId));
    } catch (error) {
      const message = errorMessage(
        error,
        t('settings:agents.openCodeProviderLoadFailed')
      );
      setConnectionError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, [agentId, t]);

  const loadCatalog = useCallback(
    async (forceRefresh = false) => {
      setCatalogLoading(true);
      setCatalogError(null);
      try {
        setCatalog(
          await agentManagementApi.openCodeProviderCatalog(forceRefresh)
        );
      } catch (error) {
        const message = errorMessage(
          error,
          t('settings:agents.openCodeProviderCatalogLoadFailed')
        );
        setCatalogError(message);
        toast.error(message);
      } finally {
        setCatalogLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    void loadConnections();
    if (allowCreate) void loadCatalog();
  }, [allowCreate, loadCatalog, loadConnections]);

  const repositionCatalogMenu = useCallback(() => {
    if (!catalogTriggerRef.current) return;
    setCatalogMenuPosition(
      getMenuPosition(catalogTriggerRef.current.getBoundingClientRect())
    );
  }, []);

  useEffect(() => {
    if (!catalogOpen) {
      setCatalogMenuPosition(null);
      return;
    }
    repositionCatalogMenu();
    window.addEventListener('scroll', repositionCatalogMenu, {
      capture: true,
      passive: true,
    });
    window.addEventListener('resize', repositionCatalogMenu);
    return () => {
      window.removeEventListener('scroll', repositionCatalogMenu, true);
      window.removeEventListener('resize', repositionCatalogMenu);
    };
  }, [catalogOpen, repositionCatalogMenu]);

  useEffect(() => {
    if (!catalogOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        catalogRef.current?.contains(target) ||
        catalogMenuRef.current?.contains(target)
      ) {
        return;
      }
      setCatalogOpen(false);
    };
    const onKeyDown = (event: { key: string }) => {
      if (event.key === 'Escape') setCatalogOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [catalogOpen]);

  const savedProviders = useMemo(
    () =>
      view?.providers.filter((provider) =>
        matchesOpenCodeSurface(provider.provider_id, surface)
      ) ?? [],
    [surface, view]
  );

  const catalogResults = useMemo(() => {
    const visible =
      catalog?.providers.filter((provider) =>
        matchesOpenCodeSurface(provider.id, surface)
      ) ?? [];
    const query = catalogQuery.trim().toLowerCase();
    if (!query) return visible;
    return visible.filter((provider) =>
      [provider.id, provider.name, provider.npm ?? '', ...provider.env]
        .join(' ')
        .toLowerCase()
        .includes(query)
    );
  }, [catalog, catalogQuery, surface]);

  const pluginCatalogResults = useMemo(() => {
    if (surface !== 'provider') return [];
    return pluginCatalogRows(pluginCatalog?.templates ?? [], catalogQuery);
  }, [catalogQuery, pluginCatalog, surface]);

  const packageOptions = useMemo(() => {
    const options = new Map<string, string>(PROVIDER_PACKAGES);
    if (npm && !options.has(npm)) options.set(npm, npm);
    return [...options];
  }, [npm]);

  const resetForm = () => {
    setProviderId('');
    setName('');
    setNpm('');
    setApi('');
    setBaseUrl('');
    setApiKey('');
    setModels([]);
    setCatalogQuery('');
    setCatalogOpen(false);
    setEditing(false);
  };

  const openCreate = () => {
    resetForm();
    setPage('form');
  };

  const adoptCatalogProvider = (provider: OpenCodeCatalogProviderView) => {
    setProviderId(provider.id);
    setName(provider.name);
    setNpm(provider.npm ?? '');
    setModels(
      provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        previous_id: null,
      }))
    );
    setCatalogOpen(false);
  };

  const adoptPluginCatalogTemplate = (
    template: ProviderCatalogTemplateView
  ) => {
    setProviderId(template.provider_id?.trim() || '');
    setName(template.name);
    setNpm(template.npm ?? '');
    setApi(template.api ?? '');
    setBaseUrl(template.base_url ?? '');
    setApiKey('');
    setModels(
      (template.models ?? []).map((model) => ({
        id: model.id,
        name: model.name?.trim() || model.id,
        previous_id: null,
      }))
    );
    setCatalogOpen(false);
  };

  const openEdit = (provider: OpenCodeProviderConnectionView) => {
    setEditing(true);
    setProviderId(provider.provider_id);
    setName(provider.name);
    setNpm(provider.npm ?? '');
    setApi(provider.api ?? '');
    setBaseUrl(provider.base_url ?? '');
    setModels(
      provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        previous_id: model.id,
      }))
    );
    setApiKey('');
    setPage('form');
  };

  const closeForm = async () => {
    if (formDirty) {
      const result = await ConfirmDialog.show({
        title: t('settings:agents.providerDiscardTitle'),
        message: t('settings:agents.providerDiscardMessage'),
        confirmText: t('settings:agents.providerDiscardConfirm'),
        cancelText: t('common:cancel'),
        variant: 'destructive',
      });
      if (result !== 'confirmed') return;
    }
    resetForm();
    setPage('list');
  };

  const addModel = () => {
    setModels((current) => [
      ...current,
      { id: '', name: '', previous_id: null },
    ]);
  };

  const patchModel = (index: number, field: 'id' | 'name', value: string) => {
    setModels((current) =>
      current.map((model, modelIndex) =>
        modelIndex === index ? { ...model, [field]: value } : model
      )
    );
  };

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const id = providerId.trim().toLowerCase();
    if (!id || (credentialRequired && !apiKey.trim())) {
      toast.warning(t('settings:agents.openCodeProviderRequired'));
      return;
    }
    const normalizedModels = models
      .filter((model) => model.id.trim() || model.name.trim())
      .map((model) => ({
        id: model.id.trim(),
        name: model.name.trim() || model.id.trim(),
        previous_id: model.previous_id?.trim() || null,
      }));
    if (normalizedModels.some((model) => !model.id)) {
      toast.warning(t('settings:agents.openCodeModelIdRequired'));
      return;
    }
    const modelIds = new Set(normalizedModels.map((model) => model.id));
    if (modelIds.size !== normalizedModels.length) {
      toast.warning(t('settings:agents.openCodeModelIdDuplicate'));
      return;
    }
    setSaving(true);
    try {
      setView(
        await agentManagementApi.connectOpenCodeProvider(
          {
            provider_id: id,
            name: name.trim() || id,
            npm: npm.trim() || null,
            api: api.trim() || null,
            base_url: baseUrl.trim() || null,
            api_key: apiKey.trim() || null,
            models: normalizedModels,
            enabled: existingProvider?.enabled ?? true,
          },
          agentId
        )
      );
      resetForm();
      setPage('list');
      toast.success(
        t('settings:agents.openCodeProviderConnected', {
          name: name.trim() || id,
        })
      );
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.openCodeProviderConnectFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async (provider: OpenCodeProviderConnectionView) => {
    const result = await ConfirmDialog.show({
      title: t('settings:agents.openCodeProviderDisconnectTitle', {
        name: provider.name,
      }),
      message: t('settings:agents.openCodeProviderDisconnectMessage'),
      confirmText: t('settings:agents.openCodeProviderDisconnectConfirm'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;
    setDisconnecting(provider.provider_id);
    try {
      setView(
        await agentManagementApi.disconnectOpenCodeProvider(
          provider.provider_id,
          agentId
        )
      );
      toast.success(
        t('settings:agents.openCodeProviderDisconnected', {
          name: provider.name,
        })
      );
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(
          error,
          t('settings:agents.openCodeProviderDisconnectFailed')
        )
      );
    } finally {
      setDisconnecting(null);
    }
  };

  const toggleProvider = async (
    provider: OpenCodeProviderConnectionView,
    enabled: boolean
  ) => {
    setToggling(provider.provider_id);
    try {
      setView(
        await agentManagementApi.setOpenCodeProviderEnabled(
          provider.provider_id,
          enabled,
          agentId
        )
      );
      toast.success(
        t(
          enabled
            ? 'settings:agents.openCodeProviderEnabledToast'
            : 'settings:agents.openCodeProviderDisabledToast',
          { name: provider.name }
        )
      );
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(
          error,
          t(
            enabled
              ? 'settings:agents.openCodeProviderEnableFailed'
              : 'settings:agents.openCodeProviderDisableFailed'
          )
        )
      );
    } finally {
      setToggling(null);
    }
  };

  const loadImport = async () => {
    setImportOpen(false);
    setSaving(true);
    try {
      const preview = await agentManagementApi.previewModelProviderImport(
        'opencode',
        'cc_switch'
      );
      setImportPreview(preview);
      setImportSelected(
        preview.candidates
          .filter((candidate) => !candidate.skip_reason)
          .map((candidate) => candidate.source_id)
      );
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.providerActionFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  const applyImport = async () => {
    setSaving(true);
    try {
      setView(
        await agentManagementApi.importOpenCodeProviders({
          agent_id: agentId,
          source: 'cc_switch',
          source_ids: importSelected,
        })
      );
      setImportPreview(null);
      setImportSelected([]);
      toast.success(t('settings:agents.providerImported'));
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.providerActionFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  const busy = saving || disconnecting !== null || toggling !== null;

  const toolbar = (
    <div className="agent-model-provider-toolbar">
      {allowCreate ? (
        <Button size="sm" className="h-8" disabled={busy} onClick={openCreate}>
          <Plus aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          {t('settings:agents.providerCreateButton')}
        </Button>
      ) : null}
      {allowImport ? (
        <div className="agent-model-provider-import">
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={busy}
            aria-expanded={importOpen}
            onClick={() => setImportOpen((open) => !open)}
          >
            <Upload aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
            {t('settings:agents.providerImport')}
          </Button>
          {importOpen ? (
            <div className="agent-model-provider-import-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => void loadImport()}
              >
                {t('settings:agents.providerImportCcSwitch')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const list = (
    <div className="agent-model-provider-body">
      {importPreview ? (
        <div className="agent-model-provider-import-preview">
          {importPreview.error ? (
            <p role="alert">{importPreview.error}</p>
          ) : null}
          {importPreview.candidates.length === 0 ? (
            <p>{t('settings:agents.providerImportEmpty')}</p>
          ) : (
            <ul>
              {importPreview.candidates.map((candidate) => (
                <li key={candidate.source_id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={importSelected.includes(candidate.source_id)}
                      disabled={Boolean(candidate.skip_reason)}
                      onChange={(event) => {
                        setImportSelected((current) =>
                          event.target.checked
                            ? [...current, candidate.source_id]
                            : current.filter((id) => id !== candidate.source_id)
                        );
                      }}
                    />
                    <span>
                      <strong>{candidate.name}</strong>
                      <small>{candidate.api_url}</small>
                      {candidate.skip_reason ? (
                        <em>{candidate.skip_reason}</em>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="agent-model-provider-import-actions">
            <Button
              className="h-8"
              size="sm"
              variant="outline"
              onClick={() => {
                setImportPreview(null);
                setImportSelected([]);
              }}
            >
              {t('settings:agents.providerImportCancel')}
            </Button>
            <Button
              className="h-8"
              disabled={saving || importSelected.length === 0}
              size="sm"
              onClick={() => void applyImport()}
            >
              {t('settings:agents.providerImportApply')}
            </Button>
          </div>
        </div>
      ) : null}

      {loading && !view ? (
        <p className="agent-model-provider-state" aria-live="polite">
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          {t('settings:agents.openCodeProviderLoading')}
        </p>
      ) : connectionError && !view ? (
        <div className="agent-inline-error" role="alert">
          <span>{connectionError}</span>
          <Button
            className="h-8 shrink-0"
            size="sm"
            variant="outline"
            onClick={() => void loadConnections()}
          >
            {t('settings:agents.retryRead')}
          </Button>
        </div>
      ) : savedProviders.length === 0 ? (
        <div className="agent-model-provider-empty">
          <p>{t('settings:agents.providerNoneDetected')}</p>
          {allowCreate ? (
            <Button
              size="sm"
              className="h-8"
              disabled={busy}
              onClick={openCreate}
            >
              <Plus aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
              {t('settings:agents.providerCreateButton')}
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="agent-model-provider-list">
          {savedProviders.map((provider) => (
            <li
              key={provider.provider_id}
              data-bound={provider.enabled ? 'true' : undefined}
            >
              <div>
                <strong>{provider.name}</strong>
                <p>
                  {provider.base_url ||
                    provider.provider_id ||
                    t('agents.providerNativeBadge')}
                </p>
              </div>
              <div className="agent-model-provider-card-actions">
                <Button
                  size="sm"
                  variant={provider.enabled ? 'outline' : 'default'}
                  className={cn(
                    'agent-model-provider-enable h-7',
                    provider.enabled && 'is-enabled'
                  )}
                  disabled={busy}
                  aria-disabled={provider.enabled || undefined}
                  aria-pressed={provider.enabled}
                  aria-label={t(
                    provider.enabled
                      ? 'settings:agents.disableNamed'
                      : 'settings:agents.enableNamed',
                    { name: provider.name }
                  )}
                  onClick={() =>
                    void toggleProvider(provider, !provider.enabled)
                  }
                >
                  {provider.enabled ? (
                    <Check aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
                  ) : null}
                  {provider.enabled
                    ? t('agents.providerEnabled')
                    : t('agents.providerEnable')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  aria-label={t('settings:agents.openCodeProviderEditAria', {
                    name: provider.name,
                  })}
                  disabled={busy}
                  onClick={() => openEdit(provider)}
                >
                  <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 w-7 p-0"
                  aria-label={t(
                    'settings:agents.openCodeProviderDisconnectAria',
                    { name: provider.name }
                  )}
                  disabled={busy}
                  onClick={() => void disconnect(provider)}
                >
                  {disconnecting === provider.provider_id ? (
                    <Loader2
                      aria-hidden="true"
                      className="h-3.5 w-3.5 animate-spin"
                    />
                  ) : (
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const catalogOptions =
    catalogResults.length || pluginCatalogResults.length ? (
      <ul
        className="agent-provider-catalog-list"
        id="opencode-provider-catalog-list"
      >
        {catalogResults.map((provider) => (
          <li key={provider.id}>
            <button
              aria-label={t('settings:agents.selectProviderAria', {
                name: provider.name,
              })}
              type="button"
              onClick={() => adoptCatalogProvider(provider)}
            >
              <span className="agent-provider-catalog-identity">
                <Database aria-hidden="true" className="h-3.5 w-3.5" />
                <span>
                  <strong>{provider.name}</strong>
                  <code>{provider.id}</code>
                </span>
              </span>
              <span className="agent-provider-catalog-meta">
                <em data-auth={provider.auth_kind}>
                  {provider.auth_kind === 'oauth' ? 'OAuth' : 'API Key'}
                </em>
                <span>
                  {t('settings:agents.modelCount', {
                    count: provider.models.length,
                  })}
                </span>
              </span>
            </button>
            {provider.doc ? (
              <Button
                aria-label={t('settings:agents.openProviderDocsAria', {
                  name: provider.name,
                })}
                className="h-8 w-8 shrink-0 p-0"
                size="sm"
                variant="ghost"
                onClick={() => void openExternalUrl(provider.doc!)}
              >
                <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </li>
        ))}
        {pluginCatalogResults.map((template) => (
          <li key={`${template.plugin_id}:${template.id}`}>
            <button
              aria-label={t('settings:agents.selectProviderAria', {
                name: template.name,
              })}
              type="button"
              onClick={() => adoptPluginCatalogTemplate(template)}
            >
              <span className="agent-provider-catalog-identity">
                <Database aria-hidden="true" className="h-3.5 w-3.5" />
                <span>
                  <strong>{template.name}</strong>
                  <code>{template.provider_id}</code>
                </span>
              </span>
              <span className="agent-provider-catalog-meta">
                <span>
                  {template.plugin_label
                    ? `${t('settings:agents.providerCatalogSourcePlugin')} · ${template.plugin_label}`
                    : t('settings:agents.providerCatalogSourcePlugin')}
                </span>
                <span>
                  {t('settings:agents.modelCount', {
                    count: template.models?.length ?? 0,
                  })}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <p className="agent-provider-catalog-empty">
        {t('settings:agents.noMatchingProviders')}
      </p>
    );

  const catalogBrowser = (
    <div ref={catalogRef} className="agent-provider-catalog">
      <div className="agent-provider-catalog-heading">
        <div>
          <strong>
            {surface === 'provider'
              ? t('settings:agents.openCodeBuiltInProviders')
              : t('settings:agents.modelsDevCatalog')}
          </strong>
          {surface === 'provider' ? null : (
            <span>{catalogSourceLabel(t, catalog?.source)}</span>
          )}
        </div>
        <Button
          aria-label={t('settings:agents.modelsDevRefreshAria')}
          className="h-8"
          disabled={catalogLoading}
          size="sm"
          variant="ghost"
          onClick={() => void loadCatalog(true)}
        >
          {catalogLoading ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {t('settings:agents.updateCatalog')}
        </Button>
      </div>
      <div ref={catalogTriggerRef} className="opencode-provider-catalog-search">
        <Search aria-hidden="true" className="h-3.5 w-3.5" />
        <input
          aria-label={t('settings:agents.searchProvider')}
          aria-expanded={catalogOpen}
          aria-controls="opencode-provider-catalog-list"
          autoComplete="off"
          name="provider_catalog_search"
          placeholder={t('settings:agents.searchProviderPlaceholder')}
          role="searchbox"
          type="text"
          value={catalogQuery}
          onChange={(event) => {
            setCatalogQuery(event.target.value);
            setCatalogOpen(true);
          }}
          onClick={() => setCatalogOpen(true)}
          onFocus={() => setCatalogOpen(true)}
        />
      </div>
      {catalogLoading && !catalog ? (
        <p className="agent-provider-catalog-empty">
          {t('settings:agents.catalogLoading')}
        </p>
      ) : catalogError && !catalog ? (
        <p className="agent-provider-catalog-empty" role="alert">
          {catalogError}
        </p>
      ) : null}
      {pluginCatalogError ? (
        <p className="agent-provider-catalog-empty" role="alert">
          {pluginCatalogError}
        </p>
      ) : null}
      {catalogOpen && catalogMenuPosition
        ? createPortal(
            <div
              ref={catalogMenuRef}
              className="agent-model-provider-catalog-menu tahoe-popover opencode-provider-catalog-menu"
              style={{
                top: catalogMenuPosition.top,
                left: catalogMenuPosition.left,
                width: catalogMenuPosition.width,
                maxHeight: catalogMenuPosition.maxHeight,
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <NativeSurfaceOcclusionHold />
              {catalogOptions}
            </div>,
            portalContainer ?? document.body
          )
        : null}
    </div>
  );

  const form = (
    <div className="agent-model-provider-form">
      <div className="agent-model-provider-form-heading">
        <Button
          size="sm"
          variant="ghost"
          className="h-8"
          onClick={() => void closeForm()}
        >
          <ArrowLeft aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          {t('settings:agents.providerFormBack')}
        </Button>
        <strong>
          {editing
            ? t('settings:agents.providerEdit')
            : t('settings:agents.providerNew')}
        </strong>
      </div>
      {editing ? null : catalogBrowser}
      <form
        className="agent-provider-form"
        onSubmit={(event) => void connect(event)}
      >
        <div className="agent-provider-form-grid">
          <ProviderField label="Provider ID" required>
            <input
              aria-label="Provider ID"
              autoComplete="off"
              disabled={editing}
              name="provider_id"
              pattern="[a-z0-9][a-z0-9._-]*"
              placeholder={t('settings:agents.providerIdPlaceholder')}
              required
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
            />
          </ProviderField>
          <ProviderField label={t('settings:agents.displayName')}>
            <input
              aria-label={t('settings:agents.displayName')}
              autoComplete="off"
              name="provider_name"
              placeholder={t('settings:agents.providerNamePlaceholder')}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </ProviderField>
          <ProviderField label={t('settings:agents.aiSdkPackage')}>
            <AstryxSelect
              ariaLabel={t('settings:agents.aiSdkPackage')}
              hasClear
              placeholder={t('settings:agents.openCodeBuiltInProvider')}
              value={npm}
              options={packageOptions.map(([value, label]) => ({
                value,
                label: `${label} · ${value}`,
              }))}
              onChange={setNpm}
            />
          </ProviderField>
          <ProviderField label={t('settings:agents.apiAdapter')}>
            <input
              aria-label={t('settings:agents.apiAdapter')}
              autoComplete="off"
              name="provider_api"
              placeholder={t('settings:agents.apiAdapterPlaceholder')}
              value={api}
              onChange={(event) => setApi(event.target.value)}
            />
          </ProviderField>
          <ProviderField label="API URL">
            <input
              aria-label="API URL"
              autoComplete="url"
              name="provider_url"
              placeholder="https://api.example.com/v1"
              readOnly={lockOfficialEndpoint}
              type="url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </ProviderField>
          <ProviderField label="API Key" required={credentialRequired}>
            <input
              aria-label="API Key"
              autoComplete="new-password"
              name="provider_api_key"
              placeholder={t(
                existingProvider?.credential_present
                  ? 'settings:agents.openCodeCredentialEditPlaceholder'
                  : 'settings:agents.credentialPlaceholder'
              )}
              required={credentialRequired}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </ProviderField>
          <div className="agent-provider-models">
            <div className="agent-provider-models-heading">
              <strong>{t('settings:agents.openCodeModelManagement')}</strong>
              <Button
                className="h-8"
                size="sm"
                type="button"
                variant="outline"
                onClick={addModel}
              >
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                {t('settings:agents.openCodeAddModel')}
              </Button>
            </div>
            {models.length ? (
              <div className="agent-provider-model-list">
                {models.map((model, index) => (
                  <div
                    className="agent-provider-model-row"
                    key={`${model.previous_id ?? 'new'}:${index}`}
                  >
                    <ProviderField label={t('settings:agents.modelId')}>
                      <input
                        aria-label={t('settings:agents.openCodeModelIdAria', {
                          index: index + 1,
                        })}
                        autoComplete="off"
                        name={`provider_model_${index}_id`}
                        placeholder="model-id"
                        spellCheck={false}
                        value={model.id}
                        onChange={(event) =>
                          patchModel(index, 'id', event.target.value)
                        }
                      />
                    </ProviderField>
                    <ProviderField label={t('settings:agents.modelName')}>
                      <input
                        aria-label={t('settings:agents.openCodeModelNameAria', {
                          index: index + 1,
                        })}
                        autoComplete="off"
                        name={`provider_model_${index}_name`}
                        placeholder={t(
                          'settings:agents.openCodeModelNamePlaceholder'
                        )}
                        value={model.name}
                        onChange={(event) =>
                          patchModel(index, 'name', event.target.value)
                        }
                      />
                    </ProviderField>
                    <Button
                      aria-label={t('settings:agents.openCodeDeleteModelAria', {
                        id: model.id || index + 1,
                      })}
                      className="h-8 w-8 self-end p-0"
                      size="sm"
                      type="button"
                      variant="ghost"
                      onClick={() =>
                        setModels((current) =>
                          current.filter(
                            (_, modelIndex) => modelIndex !== index
                          )
                        )
                      }
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p>{t('settings:agents.openCodeModelEmpty')}</p>
            )}
          </div>
        </div>
        <div className="agent-provider-form-footer" aria-live="polite">
          <Button disabled={saving} size="sm" type="submit">
            {saving ? (
              <Loader2
                aria-hidden="true"
                className="h-3.5 w-3.5 animate-spin"
              />
            ) : null}
            {saving
              ? t('settings:agents.connecting')
              : editing
                ? t('settings:agents.openCodeUpdateProvider')
                : t('settings:agents.saveAndConnect')}
          </Button>
        </div>
      </form>
    </div>
  );

  return (
    <section
      aria-labelledby={`${agentId}-model-provider-heading`}
      className="agent-model-provider-manager is-embedded"
    >
      <div className="agent-model-provider-heading">
        <h4 id={`${agentId}-model-provider-heading`}>
          {t('settings:agents.providerTitle')}
        </h4>
        {page === 'list' ? toolbar : null}
      </div>
      {page === 'form' && allowCreate ? form : list}
    </section>
  );
}

function ProviderField({
  children,
  label,
  required = false,
}: {
  children: ReactNode;
  label: string;
  required?: boolean;
}) {
  const { t } = useTranslation('settings');
  return (
    <label className="agent-provider-field">
      <span>
        {label}
        {required ? <em>{t('agents.required')}</em> : null}
      </span>
      {children}
    </label>
  );
}

function catalogSourceLabel(
  t: ReturnType<typeof useTranslation>['t'],
  source: OpenCodeProviderCatalogSource | undefined
): string {
  switch (source) {
    case 'live':
      return t('settings:agents.catalogSourceModelsDev');
    case 'cache':
      return t('settings:agents.catalogSourceCache');
    case 'bundled':
      return t('settings:agents.catalogSourceBundled');
    default:
      return t('settings:agents.catalogSourceChecking');
  }
}

async function openExternalUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return;
  try {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(parsed.toString());
  } catch {
    window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
  }
}

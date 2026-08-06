import {
  Database,
  ExternalLink,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  Trash2,
  Unplug,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  OpenCodeCatalogProviderView,
  OpenCodeProviderCatalogSource,
  OpenCodeProviderCatalogView,
  OpenCodeProviderConnectionView,
  OpenCodeProviderConnectionsView,
  OpenCodeProviderModelRequest,
} from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

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

type Props = {
  onChanged?: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
};

type ProviderModelDraft = OpenCodeProviderModelRequest;

export function OpenCodeProviderConnections({
  onChanged,
  onDirtyChange,
}: Props) {
  const { t } = useTranslation(['settings', 'common']);
  const [view, setView] = useState<OpenCodeProviderConnectionsView | null>(
    null
  );
  const [catalog, setCatalog] = useState<OpenCodeProviderCatalogView | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [providerId, setProviderId] = useState('');
  const [name, setName] = useState('');
  const [npm, setNpm] = useState('');
  const [api, setApi] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<ProviderModelDraft[]>([]);
  const formDirty = Boolean(
    providerId || name || npm || api || baseUrl || apiKey || models.length
  );
  const existingProvider = view?.providers.find(
    (provider) => provider.provider_id === providerId.trim().toLowerCase()
  );
  const credentialRequired = !existingProvider?.credential_present;

  useEffect(() => {
    onDirtyChange?.(formDirty);
    return () => onDirtyChange?.(false);
  }, [formDirty, onDirtyChange]);

  const loadConnections = useCallback(async () => {
    setLoading(true);
    setConnectionError(null);
    try {
      setView(await agentManagementApi.openCodeProviders());
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
  }, [t]);

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
    void loadCatalog();
  }, [loadCatalog, loadConnections]);

  const catalogResults = useMemo(() => {
    const query = catalogQuery.trim().toLowerCase();
    if (!query) return catalog?.providers.slice(0, 8) ?? [];
    return (
      catalog?.providers
        .filter((provider) =>
          [provider.id, provider.name, provider.npm ?? '', ...provider.env]
            .join(' ')
            .toLowerCase()
            .includes(query)
        )
        .slice(0, 20) ?? []
    );
  }, [catalog, catalogQuery]);

  const packageOptions = useMemo(() => {
    const options = new Map<string, string>(PROVIDER_PACKAGES);
    if (npm && !options.has(npm)) options.set(npm, npm);
    return [...options];
  }, [npm]);

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
  };

  const editProvider = (provider: OpenCodeProviderConnectionView) => {
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
  };

  const resetForm = () => {
    setProviderId('');
    setName('');
    setNpm('');
    setApi('');
    setBaseUrl('');
    setApiKey('');
    setModels([]);
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
        await agentManagementApi.connectOpenCodeProvider({
          provider_id: id,
          name: name.trim() || id,
          npm: npm.trim() || null,
          api: api.trim() || null,
          base_url: baseUrl.trim() || null,
          api_key: apiKey.trim() || null,
          models: normalizedModels,
          enabled: existingProvider?.enabled ?? true,
        })
      );
      resetForm();
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
          provider.provider_id
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
          enabled
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

  return (
    <section
      aria-labelledby="opencode-provider-heading"
      className="settings-surface agent-provider-surface"
    >
      <div className="agent-section-heading">
        <div className="flex items-center gap-2">
          <PlugZap aria-hidden="true" className="h-4 w-4" />
          <div>
            <h3 id="opencode-provider-heading">
              {t('settings:agents.openCodeProviderTitle')}
            </h3>
            <p className="agent-section-caption">
              {t('settings:agents.openCodeProviderDescription')}
            </p>
          </div>
        </div>
        <Button
          aria-label={t('settings:agents.openCodeProviderRefreshAria')}
          className="h-8"
          disabled={loading}
          size="sm"
          variant="ghost"
          onClick={() => void loadConnections()}
        >
          {loading ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
          )}
          {t('settings:agents.refresh')}
        </Button>
      </div>

      <div aria-live="polite">
        {loading && !view ? (
          <p className="px-4 pb-4 text-xs text-muted-foreground">
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
        ) : view?.providers.length ? (
          <ul className="agent-provider-list">
            {view.providers.map((provider) => (
              <li key={provider.provider_id}>
                <span className="agent-provider-icon">
                  <KeyRound aria-hidden="true" className="h-3.5 w-3.5" />
                </span>
                <div className="agent-provider-copy">
                  <div className="agent-provider-identity">
                    <strong>{provider.name}</strong>
                    <code>{provider.provider_id}</code>
                    <span data-enabled={provider.enabled}>
                      {provider.enabled
                        ? t('settings:agents.enabled')
                        : t('settings:agents.disabled')}
                    </span>
                  </div>
                  <p title={provider.base_url ?? undefined}>
                    {provider.credential_present
                      ? t('settings:agents.credentialPresent')
                      : t('settings:agents.credentialMissing')}
                    {provider.api ? ` · ${provider.api}` : ''}
                    {provider.base_url ? ` · ${provider.base_url}` : ''}
                    {provider.models.length
                      ? ` · ${t('settings:agents.modelCount', { count: provider.models.length })}`
                      : ''}
                  </p>
                </div>
                <div className="agent-provider-actions">
                  <Button
                    aria-label={t('settings:agents.openCodeProviderEditAria', {
                      name: provider.name,
                    })}
                    className="h-8 shrink-0"
                    disabled={
                      disconnecting === provider.provider_id ||
                      toggling === provider.provider_id
                    }
                    size="sm"
                    variant="ghost"
                    onClick={() => editProvider(provider)}
                  >
                    <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                    {t('settings:agents.openCodeProviderEdit')}
                  </Button>
                  <label className="agent-provider-enabled">
                    <span className="sr-only">
                      {t(
                        provider.enabled
                          ? 'settings:agents.disableNamed'
                          : 'settings:agents.enableNamed',
                        { name: provider.name }
                      )}
                    </span>
                    <Switch
                      aria-label={t(
                        provider.enabled
                          ? 'settings:agents.disableNamed'
                          : 'settings:agents.enableNamed',
                        { name: provider.name }
                      )}
                      checked={provider.enabled}
                      className="agent-provider-switch"
                      disabled={
                        toggling === provider.provider_id ||
                        disconnecting === provider.provider_id
                      }
                      onCheckedChange={(enabled) =>
                        void toggleProvider(provider, enabled)
                      }
                    />
                  </label>
                  <Button
                    aria-label={t(
                      'settings:agents.openCodeProviderDisconnectAria',
                      { name: provider.name }
                    )}
                    className="h-8 shrink-0"
                    disabled={
                      disconnecting === provider.provider_id ||
                      toggling === provider.provider_id
                    }
                    size="sm"
                    variant="ghost"
                    onClick={() => void disconnect(provider)}
                  >
                    {disconnecting === provider.provider_id ? (
                      <Loader2
                        aria-hidden="true"
                        className="h-3.5 w-3.5 animate-spin"
                      />
                    ) : (
                      <Unplug aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    {t('settings:agents.disconnect')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 pb-4 text-xs text-muted-foreground">
            {t('settings:agents.openCodeProviderEmpty')}
          </p>
        )}
      </div>

      <div className="agent-provider-catalog">
        <div className="agent-provider-catalog-heading">
          <div>
            <strong>{t('settings:agents.modelsDevCatalog')}</strong>
            <span>{catalogSourceLabel(t, catalog?.source)}</span>
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
              <Loader2
                aria-hidden="true"
                className="h-3.5 w-3.5 animate-spin"
              />
            ) : (
              <RefreshCw aria-hidden="true" className="h-3.5 w-3.5" />
            )}
            {t('settings:agents.updateCatalog')}
          </Button>
        </div>
        <label className="agent-provider-search">
          <Search aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">{t('settings:agents.searchProvider')}</span>
          <input
            aria-label={t('settings:agents.searchProvider')}
            autoComplete="off"
            name="provider_catalog_search"
            placeholder={t('settings:agents.searchProviderPlaceholder')}
            type="search"
            value={catalogQuery}
            onChange={(event) => setCatalogQuery(event.target.value)}
          />
        </label>
        <div aria-live="polite">
          {catalogLoading && !catalog ? (
            <p className="agent-provider-catalog-empty">
              {t('settings:agents.catalogLoading')}
            </p>
          ) : catalogError && !catalog ? (
            <p className="agent-provider-catalog-empty" role="alert">
              {catalogError}
            </p>
          ) : catalogResults.length ? (
            <ul className="agent-provider-catalog-list">
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
                      <ExternalLink
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                      />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="agent-provider-catalog-empty">
              {t('settings:agents.noMatchingProviders')}
            </p>
          )}
        </div>
      </div>

      <form
        className="agent-provider-form"
        onSubmit={(event) => void connect(event)}
      >
        <div className="agent-provider-form-heading">
          <strong>{t('settings:agents.connectProvider')}</strong>
          <span>{t('settings:agents.connectProviderDescription')}</span>
        </div>
        <div className="agent-provider-form-grid">
          <ProviderField label="Provider ID" required>
            <input
              aria-label="Provider ID"
              autoComplete="off"
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
            <select
              aria-label={t('settings:agents.aiSdkPackage')}
              className="raised-control"
              name="provider_npm"
              value={npm}
              onChange={(event) => setNpm(event.target.value)}
            >
              <option value="">
                {t('settings:agents.openCodeBuiltInProvider')}
              </option>
              {packageOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label} · {value}
                </option>
              ))}
            </select>
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
              <div>
                <strong>{t('settings:agents.openCodeModelManagement')}</strong>
                <span>{t('settings:agents.openCodeModelDescription')}</span>
              </div>
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
              : existingProvider
                ? t('settings:agents.openCodeUpdateProvider')
                : t('settings:agents.saveAndConnect')}
          </Button>
        </div>
      </form>
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

import {
  ChevronDown,
  Link2,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentId,
  AgentModelCatalogView,
  AgentModelProviderView,
  AgentModelProvidersView,
  CodexModelCatalogConfigRequest,
} from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

import { CodexModelConfigFields } from './CodexModelCatalogEditor';

const CLAUDE_MODEL_FIELDS = [
  ['main', 'providerModelMain'],
  ['reasoning', 'providerModelReasoning'],
  ['haiku', 'providerModelHaiku'],
  ['sonnet', 'providerModelSonnet'],
  ['opus', 'providerModelOpus'],
  ['customOption', 'providerModelCustomId'],
  ['customOptionName', 'providerModelCustomName'],
  ['customOptionDescription', 'providerModelCustomDescription'],
] as const;

export function AgentModelProviderManager({
  agentId,
  disabled,
  onDirtyChange,
  embedded = false,
}: {
  agentId: AgentId;
  disabled: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  embedded?: boolean;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [view, setView] = useState<AgentModelProvidersView | null>(null);
  const [codexCatalog, setCodexCatalog] =
    useState<AgentModelCatalogView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const formDirty = Boolean(id || name || apiUrl || apiKey || model);

  useEffect(() => {
    onDirtyChange?.(formDirty);
    return () => onDirtyChange?.(false);
  }, [formDirty, onDirtyChange]);

  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
    setView(null);
    setCodexCatalog(null);
    setLoaded(false);
    setLoading(false);
    setSaving(false);
    setError(null);
    setId(null);
    setName('');
    setApiUrl('');
    setApiKey('');
    setModel('');
  }, [agentId]);

  const load = useCallback(async () => {
    if (loaded || loading) return;
    setLoading(true);
    setError(null);
    try {
      const [providers, catalog] = await Promise.all([
        agentManagementApi.modelProviders(agentId),
        agentId === 'codex'
          ? agentManagementApi.codexModelCatalog(false)
          : Promise.resolve(null),
      ]);
      setView(providers);
      setCodexCatalog(catalog);
      setLoaded(true);
    } catch (cause) {
      setError(errorMessage(cause, t('settings:agents.providerActionFailed')));
    } finally {
      setLoading(false);
    }
  }, [agentId, loaded, loading, t]);

  useEffect(() => {
    if (embedded) void load();
  }, [embedded, load]);

  const resetForm = () => {
    setId(null);
    setName('');
    setApiUrl('');
    setApiKey('');
    setModel('');
  };

  const edit = (provider: AgentModelProviderView) => {
    setId(provider.id);
    setName(provider.name);
    setApiUrl(provider.api_url);
    setApiKey('');
    setModel(provider.model);
  };

  const save = async () => {
    if (!name.trim() || !apiUrl.trim() || (!id && !apiKey.trim())) {
      toast.warning(t('settings:agents.providerRequiredFields'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      setView(
        await agentManagementApi.saveModelProvider({
          id,
          name: name.trim(),
          agent_id: agentId,
          api_url: apiUrl.trim(),
          api_key: apiKey.trim() || null,
          model: model.trim(),
        })
      );
      toast.success(
        id
          ? t('settings:agents.providerUpdated')
          : t('settings:agents.providerCreated')
      );
      resetForm();
    } catch (cause) {
      const message = errorMessage(
        cause,
        t('settings:agents.providerActionFailed')
      );
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const bind = async (providerId: string | null) => {
    setSaving(true);
    setError(null);
    try {
      setView(await agentManagementApi.bindModelProvider(agentId, providerId));
      toast.success(
        providerId
          ? t('settings:agents.providerBound')
          : t('settings:agents.providerUnbound')
      );
    } catch (cause) {
      const message = errorMessage(
        cause,
        t('settings:agents.providerActionFailed')
      );
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (provider: AgentModelProviderView) => {
    const result = await ConfirmDialog.show({
      title: t('settings:agents.providerDeleteTitle', {
        name: provider.name,
      }),
      message: t('settings:agents.providerDeleteMessage'),
      confirmText: t('settings:agents.providerDeleteConfirm'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;
    setSaving(true);
    try {
      setView(
        await agentManagementApi.deleteModelProvider(agentId, provider.id)
      );
      if (id === provider.id) resetForm();
      toast.success(t('settings:agents.providerDeleted'));
    } catch (cause) {
      const message = errorMessage(
        cause,
        t('settings:agents.providerActionFailed')
      );
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const content = (
    <>
      {loading ? (
        <p className="agent-model-provider-state" aria-live="polite">
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          {t('settings:agents.providerLoading')}
        </p>
      ) : view ? (
        <div className="agent-model-provider-body">
          <label className="agent-model-provider-binding">
            <span>{t('settings:agents.providerCurrentBinding')}</span>
            <select
              aria-label={t('settings:agents.providerCurrentBindingAria')}
              autoComplete="off"
              className="raised-control"
              disabled={disabled || saving}
              name={`${agentId}_bound_model_provider`}
              value={view.bound_provider_id ?? ''}
              onChange={(event) => void bind(event.target.value || null)}
            >
              <option value="">{t('settings:agents.providerNotBound')}</option>
              {view.providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>

          {view.providers.length ? (
            <ul className="agent-model-provider-list">
              {view.providers.map((provider) => (
                <li key={provider.id} data-bound={provider.bound}>
                  <div>
                    <strong>{provider.name}</strong>
                    <p>
                      {provider.model}
                      {provider.api_url ? ` · ${provider.api_url}` : ''}
                      {provider.bound
                        ? ` · ${t('settings:agents.providerBoundBadge')}`
                        : ''}
                    </p>
                  </div>
                  <div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      aria-label={t('settings:agents.providerEditAria', {
                        name: provider.name,
                      })}
                      disabled={disabled || saving}
                      onClick={() => edit(provider)}
                    >
                      <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0"
                      aria-label={t('settings:agents.providerDeleteAria', {
                        name: provider.name,
                      })}
                      disabled={disabled || saving || provider.bound}
                      onClick={() => void remove(provider)}
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="agent-model-provider-form">
            <div className="agent-model-provider-form-heading">
              <strong>
                {id
                  ? t('settings:agents.providerEdit')
                  : t('settings:agents.providerNew')}
              </strong>
              {id ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7"
                  onClick={resetForm}
                >
                  {t('settings:agents.providerCancelEdit')}
                </Button>
              ) : null}
            </div>
            <div className="agent-model-provider-form-grid">
              <label>
                <span>{t('settings:agents.name')}</span>
                <input
                  aria-label={t('settings:agents.providerNameAria')}
                  autoComplete="off"
                  disabled={disabled || saving}
                  name={`${agentId}_model_provider_name`}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <label>
                <span>API URL</span>
                <input
                  aria-label="Provider API URL"
                  autoComplete="off"
                  disabled={disabled || saving}
                  name={`${agentId}_model_provider_url`}
                  spellCheck={false}
                  type="url"
                  value={apiUrl}
                  onChange={(event) => setApiUrl(event.target.value)}
                />
              </label>
              <label>
                <span>API Key</span>
                <input
                  aria-label="Provider API Key"
                  autoComplete="new-password"
                  disabled={disabled || saving}
                  name={`${agentId}_model_provider_api_key`}
                  placeholder={
                    id
                      ? t('settings:agents.providerKeyKeepPlaceholder')
                      : t('settings:agents.providerKeyPlaceholder')
                  }
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
              {agentId === 'claude_code' ? (
                <ClaudeProviderModelEditor
                  disabled={disabled || saving}
                  value={model}
                  onChange={setModel}
                />
              ) : agentId === 'codex' ? (
                <div className="agent-model-provider-codex">
                  <span>{t('settings:agents.modelCatalog')}</span>
                  {codexCatalog?.models.length ? (
                    <div className="codex-model-editor-body">
                      <CodexModelConfigFields
                        catalog={codexCatalog}
                        disabled={disabled || saving}
                        draft={parseCodexModel(model)}
                        onChange={(next) => setModel(serializeCodexModel(next))}
                      />
                    </div>
                  ) : (
                    <p role={codexCatalog?.error ? 'alert' : undefined}>
                      {codexCatalog?.error ??
                        t('settings:agents.codexCatalogWaiting')}
                    </p>
                  )}
                </div>
              ) : (
                <label className="agent-model-provider-model">
                  <span>{t('settings:agents.model')}</span>
                  <input
                    aria-label={t('settings:agents.providerModelAria')}
                    autoComplete="off"
                    disabled={disabled || saving}
                    name={`${agentId}_model_provider_model`}
                    spellCheck={false}
                    placeholder={t('settings:agents.providerModelPlaceholder')}
                    value={model}
                    onChange={(event) => setModel(event.target.value)}
                  />
                </label>
              )}
            </div>
            <Button
              size="sm"
              className="h-8 self-end"
              disabled={disabled || saving}
              onClick={() => void save()}
            >
              {id ? (
                <Link2 aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
              ) : (
                <Plus aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
              )}
              {id
                ? t('settings:agents.saveChanges')
                : t('settings:agents.providerCreate')}
            </Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="agent-model-provider-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );

  if (embedded) {
    return (
      <section
        aria-labelledby={`${agentId}-model-provider-heading`}
        className="agent-model-provider-manager is-embedded"
      >
        <h4 id={`${agentId}-model-provider-heading`}>
          {t('settings:agents.providerTitle')}
        </h4>
        {content}
      </section>
    );
  }

  return (
    <details
      ref={detailsRef}
      className="agent-model-provider-manager"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary>
        <span>
          <strong>{t('settings:agents.providerTitle')}</strong>
        </span>
        <ChevronDown aria-hidden="true" className="h-4 w-4" />
      </summary>
      {content}
    </details>
  );
}

function ClaudeProviderModelEditor({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const parsed = parseClaudeModel(value);
  return (
    <fieldset className="agent-model-provider-claude">
      <legend>{t('agents.providerModelMapping')}</legend>
      {CLAUDE_MODEL_FIELDS.map(([key, labelKey]) => (
        <label key={key}>
          <span>{t(`agents.${labelKey}`)}</span>
          <input
            aria-label={t('agents.providerModelFieldAria', {
              label: t(`agents.${labelKey}`),
            })}
            autoComplete="off"
            disabled={disabled}
            name={`claude_provider_${key}`}
            spellCheck={false}
            value={parsed[key] ?? ''}
            onChange={(event) => {
              const next = { ...parsed };
              const nextValue = event.target.value;
              if (nextValue) next[key] = nextValue;
              else delete next[key];
              onChange(Object.keys(next).length ? JSON.stringify(next) : '');
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}

function parseClaudeModel(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
  } catch {
    return value.trim() ? { main: value.trim() } : {};
  }
}

function parseCodexModel(value: string): CodexModelCatalogConfigRequest {
  try {
    const parsed = JSON.parse(value) as Partial<CodexModelCatalogConfigRequest>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid');
    }
    return {
      customs: Array.isArray(parsed.customs) ? parsed.customs : [],
      excluded_officials: Array.isArray(parsed.excluded_officials)
        ? parsed.excluded_officials
        : [],
      default_model:
        typeof parsed.default_model === 'string' ? parsed.default_model : null,
    };
  } catch {
    return {
      customs: [],
      excluded_officials: [],
      default_model: value.trim() || null,
    };
  }
}

function serializeCodexModel(value: CodexModelCatalogConfigRequest) {
  if (
    !value.customs.length &&
    !value.excluded_officials.length &&
    !value.default_model
  ) {
    return '';
  }
  return JSON.stringify(value);
}

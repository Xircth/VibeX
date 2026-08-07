import {
  ChevronDown,
  Link2,
  Loader2,
  Pencil,
  Plus,
  ScanSearch,
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
  CodexModelCatalogConfigView,
} from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
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
  const isCodex = agentId === 'codex';
  const [view, setView] = useState<AgentModelProvidersView | null>(null);
  const [codexCatalog, setCodexCatalog] =
    useState<AgentModelCatalogView | null>(null);
  const [codexConfig, setCodexConfig] =
    useState<CodexModelCatalogConfigView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [detectedCatalog, setDetectedCatalog] =
    useState<AgentModelCatalogView | null>(null);
  const [detectingModels, setDetectingModels] = useState(false);
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const [claudeMappingTarget, setClaudeMappingTarget] = useState('main');
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
    setCodexConfig(null);
    setLoaded(false);
    setLoading(false);
    setSaving(false);
    setError(null);
    setId(null);
    setName('');
    setApiUrl('');
    setApiKey('');
    setModel('');
    setDetectedCatalog(null);
    setDetectingModels(false);
    setDetectionError(null);
    setClaudeMappingTarget('main');
  }, [agentId]);

  const load = useCallback(async () => {
    if (loaded || loading) return;
    setLoading(true);
    setError(null);
    try {
      const [providers, catalog, modelConfig] = await Promise.all([
        agentManagementApi.modelProviders(agentId),
        agentId === 'codex'
          ? agentManagementApi.codexModelCatalog(false)
          : Promise.resolve(null),
        agentId === 'codex'
          ? agentManagementApi.codexModelCatalogConfig()
          : Promise.resolve(null),
      ]);
      setView(providers);
      setCodexCatalog(catalog);
      setCodexConfig(modelConfig);
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
    setDetectedCatalog(null);
    setDetectionError(null);
  };

  const edit = (provider: AgentModelProviderView) => {
    setId(provider.id);
    setName(provider.name);
    setApiUrl(provider.api_url);
    setApiKey('');
    setModel(provider.model);
    setDetectedCatalog(null);
    setDetectionError(null);
  };

  const detectModels = async () => {
    setDetectingModels(true);
    setDetectionError(null);
    try {
      const catalog = await agentManagementApi.modelProviderCatalog(
        agentId,
        id,
        apiUrl.trim(),
        apiKey.trim() || null
      );
      setDetectedCatalog(catalog);
      setDetectionError(catalog.error);
    } catch (cause) {
      setDetectedCatalog(null);
      setDetectionError(
        errorMessage(cause, t('settings:agents.providerModelDetectionFailed'))
      );
    } finally {
      setDetectingModels(false);
    }
  };

  const addDetectedModel = (modelId: string) => {
    const detected = detectedCatalog?.models.find(
      (candidate) => candidate.id === modelId
    );
    if (!detected) return;
    if (agentId === 'claude_code') {
      const next = parseClaudeModel(model);
      next[claudeMappingTarget] = detected.id;
      setModel(JSON.stringify(next));
      return;
    }
    if (agentId === 'codex') {
      const draft = mergeCodexConfigDraft(parseCodexModel(model), codexConfig);
      const isOfficial = codexCatalog?.models.some(
        (candidate) => candidate.id === detected.id
      );
      const alreadyCustom = draft.customs.some(
        (candidate) => candidate.slug === detected.id
      );
      const base =
        draft.default_model &&
        codexCatalog?.models.some(
          (candidate) => candidate.id === draft.default_model
        )
          ? draft.default_model
          : codexCatalog?.models[0]?.id;
      if (!isOfficial && !alreadyCustom && base) {
        draft.customs = [
          ...draft.customs,
          {
            slug: detected.id,
            display_name: detected.label,
            context_window: detected.context_window,
            base,
          },
        ];
      }
      draft.default_model = detected.id;
      setModel(serializeCodexModel(draft));
      return;
    }
    setModel(detected.id);
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

  const remove = async (
    provider: AgentModelProviderView,
    switchDefault = false
  ) => {
    const result = await ConfirmDialog.show({
      title: t('settings:agents.providerDeleteTitle', {
        name: provider.name,
      }),
      message: switchDefault
        ? t('settings:agents.providerDeleteSwitchMessage')
        : t('settings:agents.providerDeleteMessage'),
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
        <div
          className={cn(
            'agent-model-provider-body',
            isCodex && 'is-codex-layout'
          )}
        >
          <ModelProviderBinding
            agentId={agentId}
            disabled={disabled}
            saving={saving}
            view={view}
            onBind={(value) => void bind(value || null)}
            onDelete={(provider) => void remove(provider, true)}
            onEdit={edit}
            nativeBadge={t('settings:agents.providerNativeBadge')}
            notBoundLabel={t('settings:agents.providerNotBound')}
            ariaLabel={t('settings:agents.providerCurrentBindingAria')}
            label={t('settings:agents.providerCurrentBinding')}
          />
          {view.providers.length ? (
            <ul
              className={cn(
                'agent-model-provider-list',
                isCodex && 'is-codex-summary'
              )}
            >
              {view.providers.map((provider) => (
                <li
                  key={`${provider.managed ? 'managed' : 'native'}-${provider.id}`}
                  data-bound={provider.bound}
                >
                  {isCodex ? (
                    <div className="agent-model-provider-summary">
                      {provider.model ? (
                        <span className="agent-model-provider-summary-model">
                          {provider.model}
                        </span>
                      ) : null}
                      {provider.model && provider.api_url ? (
                        <span
                          aria-hidden="true"
                          className="agent-model-provider-summary-divider"
                        />
                      ) : null}
                      {provider.api_url ? (
                        <span className="agent-model-provider-summary-endpoint">
                          {provider.api_url}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <div>
                      <strong>{provider.name}</strong>
                      <p>
                        {provider.model}
                        {provider.api_url ? ` · ${provider.api_url}` : ''}
                        {provider.bound
                          ? ` · ${t('settings:agents.providerBoundBadge')}`
                          : ''}
                        {!provider.managed
                          ? ` · ${t('settings:agents.providerNativeBadge')}`
                          : ''}
                      </p>
                    </div>
                  )}
                  {!isCodex && provider.managed ? (
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
                  ) : null}
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
                  onChange={(event) => {
                    setApiUrl(event.target.value);
                    setDetectedCatalog(null);
                    setDetectionError(null);
                  }}
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
                  onChange={(event) => {
                    setApiKey(event.target.value);
                    setDetectedCatalog(null);
                    setDetectionError(null);
                  }}
                />
              </label>
              <ProviderModelDetection
                agentId={agentId}
                catalog={detectedCatalog}
                claudeMappingTarget={claudeMappingTarget}
                disabled={
                  disabled ||
                  saving ||
                  !apiUrl.trim() ||
                  (!id && !apiKey.trim())
                }
                error={detectionError}
                loading={detectingModels}
                onDetect={() => void detectModels()}
                onMappingTargetChange={setClaudeMappingTarget}
                onSelectModel={addDetectedModel}
              />
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
                        draft={mergeCodexConfigDraft(
                          parseCodexModel(model),
                          codexConfig
                        )}
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

const CLAUDE_DETECTED_MODEL_TARGETS = CLAUDE_MODEL_FIELDS.filter(
  ([key]) => !['customOptionName', 'customOptionDescription'].includes(key)
);

function ProviderModelDetection({
  agentId,
  catalog,
  claudeMappingTarget,
  disabled,
  error,
  loading,
  onDetect,
  onMappingTargetChange,
  onSelectModel,
}: {
  agentId: AgentId;
  catalog: AgentModelCatalogView | null;
  claudeMappingTarget: string;
  disabled: boolean;
  error: string | null;
  loading: boolean;
  onDetect: () => void;
  onMappingTargetChange: (value: string) => void;
  onSelectModel: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const models = catalog?.models ?? [];
  return (
    <div className="agent-model-provider-detection">
      <div className="agent-model-provider-detection-actions">
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          aria-busy={loading}
          disabled={disabled || loading}
          onClick={onDetect}
        >
          {loading ? (
            <Loader2
              aria-hidden="true"
              className="mr-1.5 h-3.5 w-3.5 animate-spin"
            />
          ) : (
            <ScanSearch aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t('agents.providerDetectModels')}
        </Button>
        {models.length > 0 && agentId === 'claude_code' ? (
          <AstryxSelect
            ariaLabel={t('agents.providerDetectedMappingTargetAria')}
            disabled={disabled || loading}
            value={claudeMappingTarget}
            options={CLAUDE_DETECTED_MODEL_TARGETS.map(([key, labelKey]) => ({
              value: key,
              label: t(`agents.${labelKey}`),
            }))}
            onChange={onMappingTargetChange}
          />
        ) : null}
        {models.length > 0 ? (
          <AstryxSelect
            ariaLabel={t('agents.providerDetectedModelAria')}
            disabled={disabled || loading}
            placeholder={t('agents.providerDetectedModelPlaceholder')}
            value=""
            options={models.map((detected) => ({
              value: detected.id,
              label:
                detected.label === detected.id
                  ? detected.id
                  : `${detected.label} · ${detected.id}`,
            }))}
            onChange={onSelectModel}
          />
        ) : null}
      </div>
      {loading ? (
        <p aria-live="polite">{t('agents.providerDetectingModels')}</p>
      ) : catalog ? (
        <p aria-live="polite">
          {models.length
            ? t('agents.providerDetectedModelCount', {
                count: models.length,
              })
            : t('agents.providerDetectedModelsEmpty')}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
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

/**
 * 未在 Provider 表单中编辑模型时，用 Codex 原生配置的实际状态（customs /
 * excluded_officials / default_model）填充编辑器，使手写的原生配置也能如实
 * 呈现，而不是只显示官方模型模板。
 */
function mergeCodexConfigDraft(
  draft: CodexModelCatalogConfigRequest,
  config: CodexModelCatalogConfigView | null
): CodexModelCatalogConfigRequest {
  if (
    draft.default_model ||
    draft.customs.length ||
    draft.excluded_officials.length ||
    !config
  ) {
    return draft;
  }
  return {
    customs: config.customs,
    excluded_officials: config.excluded_officials,
    default_model: config.default_model,
  };
}

function ModelProviderBinding({
  agentId,
  ariaLabel,
  disabled,
  label,
  nativeBadge,
  notBoundLabel,
  onBind,
  onDelete,
  onEdit,
  saving,
  view,
}: {
  agentId: AgentId;
  ariaLabel: string;
  disabled: boolean;
  label: string;
  nativeBadge: string;
  notBoundLabel: string;
  onBind: (value: string | null) => void;
  onDelete: (provider: AgentModelProviderView) => void;
  onEdit: (provider: AgentModelProviderView) => void;
  saving: boolean;
  view: AgentModelProvidersView;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const codex = agentId === 'codex';
  const managed = view.providers.filter((provider) => provider.managed);
  const boundNative = view.providers.find(
    (provider) => provider.bound && !provider.managed
  );
  const options = [
    ...(boundNative
      ? [
          {
            value: boundNative.id,
            label: `${boundNative.name}（${nativeBadge}）`,
            disabled: true,
          },
        ]
      : []),
    ...managed.map((provider) => ({
      value: provider.id,
      label: provider.name,
    })),
  ];
  return (
    <label className="agent-model-provider-binding">
      {!codex ? <span>{label}</span> : null}
      <AstryxSelect
        ariaLabel={ariaLabel}
        disabled={disabled || saving}
        hasClear={!codex}
        placeholder={notBoundLabel}
        value={view.bound_provider_id ?? ''}
        options={options}
        onChange={onBind}
        renderOptionAction={
          codex
            ? (option) => {
                const provider = view.providers.find(
                  (candidate) => candidate.id === option.value
                );
                if (!provider?.managed) return null;
                return (
                  <div className="agent-model-provider-option-actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      aria-label={t('settings:agents.providerEditAria', {
                        name: provider.name,
                      })}
                      disabled={disabled || saving}
                      onClick={() => onEdit(provider)}
                    >
                      <Pencil aria-hidden="true" className="h-3 w-3" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      aria-label={t('settings:agents.providerDeleteAria', {
                        name: provider.name,
                      })}
                      disabled={disabled || saving}
                      onClick={() => void onDelete(provider)}
                    >
                      <Trash2 aria-hidden="true" className="h-3 w-3" />
                    </Button>
                  </div>
                );
              }
            : undefined
        }
      />
    </label>
  );
}

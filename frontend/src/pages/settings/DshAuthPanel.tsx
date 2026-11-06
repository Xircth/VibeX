import {
  ArrowLeft,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  ScanSearch,
  Server,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DshProviderModelView, DshProvidersView } from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { TextInput } from '@astryxdesign/core/TextInput';
import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';

import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

import {
  clearAgentSettingsDraft,
  peekAgentSettingsDraft,
  retainAgentSettingsDraft,
} from './agentSettingsDraftRetention';
import { ProviderCatalogPicker } from './ProviderCatalogPicker';
import type { ProviderCatalogTemplateView } from './providerCatalogTypes';
import { useProviderCatalogList } from './useProviderCatalogList';

const DRAFT_KEY = 'dsh-auth';
const AUTH_TABS = [
  {
    value: 'deepseek',
    labelKey: 'settings:agents.authModeTabOfficialApi',
    Icon: KeyRound,
  },
  {
    value: 'custom',
    labelKey: 'settings:agents.authModeTabProvider',
    Icon: Server,
  },
] as const;

const OFFICIAL_ID = 'deepseek-official';
const CUSTOM_ID = 'custom-gateway';
const OFFICIAL_URL = 'https://api.deepseek.com';
const OFFICIAL_ANTHROPIC_URL = 'https://api.deepseek.com/anthropic';
const OFFICIAL_URLS = [OFFICIAL_URL, OFFICIAL_ANTHROPIC_URL] as const;

function normalizeOfficialUrl(url?: string | null): string {
  return (url ?? '').trim().replace(/\/+$/u, '');
}

function isOfficialBaseUrl(url?: string | null): boolean {
  const normalized = normalizeOfficialUrl(url);
  return OFFICIAL_URLS.some((candidate) => candidate === normalized);
}

type Draft = {
  mode: string;
  apiKey: string;
  displayName: string;
  notes: string;
  baseUrl: string;
  model: string;
  models: DshProviderModelView[];
};

type Props = {
  onChanged?: () => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  locked?: boolean;
};

export function DshAuthPanel({
  onChanged,
  onDirtyChange,
  locked = false,
}: Props) {
  const { t } = useTranslation(['settings', 'common']);
  const [view, setView] = useState<DshProvidersView | null>(null);
  const [savedMode, setSavedMode] = useState('deepseek');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [apiKeyRevealed, setApiKeyRevealed] = useState(false);
  const [draft, setDraft] = useState<Draft>(
    () => peekAgentSettingsDraft<Draft>(DRAFT_KEY) ?? emptyDraft('deepseek')
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [availableModels, setAvailableModels] = useState<
    DshProviderModelView[]
  >(() => peekAgentSettingsDraft<Draft>(DRAFT_KEY)?.models ?? []);
  const skipBlurSaveRef = useRef(false);
  const [customSurface, setCustomSurface] = useState<'list' | 'form'>(() =>
    peekAgentSettingsDraft<Draft>(DRAFT_KEY)?.mode === 'custom'
      ? 'form'
      : 'list'
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [endpointCandidates, setEndpointCandidates] = useState<string[]>([]);
  const catalogEnabled =
    draft.mode === 'custom' && customSurface === 'form' && editingId === null;
  const { catalog, catalogError, catalogGeneration, hasCatalogContributions } =
    useProviderCatalogList('deepseek_harness', catalogEnabled);

  const official = view?.providers.find(
    (provider) => provider.id === OFFICIAL_ID
  );
  const custom = view?.providers.find((provider) => provider.kind === 'custom');
  const officialMode = draft.mode !== 'custom';
  const customProviders =
    view?.providers.filter((provider) => provider.kind !== 'official') ?? [];

  const hydrate = useCallback((next: DshProvidersView, mode: string): Draft => {
    const officialProvider = next.providers.find(
      (provider) => provider.id === OFFICIAL_ID
    );
    const customProvider =
      next.providers.find((provider) => provider.kind === 'custom') ??
      next.providers.find(
        (provider) =>
          provider.id !== OFFICIAL_ID &&
          (provider.id === next.default_provider || provider.credential_present)
      );
    const officialCustomUrl = officialProvider?.base_url?.trim();
    const normalizedOfficialUrl = normalizeOfficialUrl(officialCustomUrl);
    if (mode !== 'custom') {
      const officialBaseUrl = OFFICIAL_URLS.find(
        (candidate) => candidate === normalizedOfficialUrl
      );
      return {
        mode: 'deepseek',
        apiKey: officialProvider?.api_key ?? '',
        displayName: officialProvider?.display_name ?? 'DeepSeek',
        notes: '',
        baseUrl: officialBaseUrl ?? OFFICIAL_URL,
        models: officialProvider?.models ?? [],
        model:
          next.default_provider === OFFICIAL_ID
            ? next.default_model
            : (officialProvider?.models[0]?.id ?? ''),
      };
    }
    const fromOfficialCustom =
      !customProvider &&
      Boolean(officialCustomUrl) &&
      !isOfficialBaseUrl(officialCustomUrl);
    return {
      mode: 'custom',
      apiKey: customProvider?.api_key ?? '',
      displayName: customProvider?.display_name ?? '',
      notes: customProvider?.notes ?? '',
      baseUrl: fromOfficialCustom
        ? (officialCustomUrl ?? '')
        : (customProvider?.base_url ?? ''),
      models:
        customProvider?.models ??
        (fromOfficialCustom ? (officialProvider?.models ?? []) : []),
      model:
        customProvider && next.default_provider === customProvider.id
          ? next.default_model
          : fromOfficialCustom
            ? next.default_model
            : (customProvider?.models[0]?.id ?? ''),
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [next, auth] = await Promise.all([
        agentManagementApi.dshProviders(),
        agentManagementApi.authMode('deepseek_harness'),
      ]);
      setView(next);
      setSavedMode(auth.mode);
      const initialDraft =
        peekAgentSettingsDraft<Draft>(DRAFT_KEY) ?? hydrate(next, auth.mode);
      draftRef.current = initialDraft;
      setDraft(initialDraft);
      setAvailableModels(initialDraft.models);
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.dshProviderLoadFailed'))
      );
    } finally {
      setLoading(false);
    }
  }, [hydrate, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const editingCustom = editingId
    ? (view?.providers.find((provider) => provider.id === editingId) ?? custom)
    : custom;

  const saved = useMemo(() => {
    if (!view) return emptyDraft(savedMode);
    if (draft.mode === 'custom' && editingId) {
      const provider = view.providers.find((entry) => entry.id === editingId);
      if (provider) {
        return {
          mode: 'custom',
          apiKey: provider.api_key ?? '',
          displayName: provider.display_name,
          notes: provider.notes ?? '',
          baseUrl: provider.base_url ?? '',
          model:
            view.default_provider === provider.id
              ? view.default_model
              : (provider.models[0]?.id ?? ''),
          models: provider.models,
        };
      }
    }
    return hydrate(view, savedMode);
  }, [draft.mode, editingId, hydrate, savedMode, view]);

  const dirty = useMemo(() => {
    if (!view) return false;
    return (
      draft.mode !== saved.mode ||
      draft.apiKey !== saved.apiKey ||
      draft.displayName !== saved.displayName ||
      draft.notes !== saved.notes ||
      draft.baseUrl !== saved.baseUrl ||
      draft.model !== saved.model ||
      JSON.stringify(draft.models) !== JSON.stringify(saved.models)
    );
  }, [draft, saved, view]);

  useEffect(() => {
    if (!view) return;
    if (dirty) retainAgentSettingsDraft(DRAFT_KEY, draft);
    else clearAgentSettingsDraft(DRAFT_KEY);
  }, [dirty, draft, view]);

  useEffect(() => {
    onDirtyChange?.(saving ? false : dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange, saving]);

  const draftChanged = (next: Draft) => {
    if (!view) return false;
    const baseline =
      next.mode === 'custom' && editingId ? saved : hydrate(view, savedMode);
    return (
      next.mode !== baseline.mode ||
      next.apiKey !== baseline.apiKey ||
      next.displayName !== baseline.displayName ||
      next.notes !== baseline.notes ||
      next.baseUrl !== baseline.baseUrl ||
      next.model !== baseline.model ||
      JSON.stringify(next.models) !== JSON.stringify(baseline.models)
    );
  };

  const save = async (next: Draft = draftRef.current) => {
    const isOfficial = next.mode !== 'custom';
    const credentialPresent = Boolean(
      isOfficial
        ? official?.credential_present
        : editingCustom?.credential_present
    );
    if (!draftChanged(next)) return;
    if (!isOfficial && !next.baseUrl.trim()) return;
    if (!next.apiKey.trim() && !credentialPresent) return;
    onDirtyChange?.(false);
    setSaving(true);
    try {
      await agentManagementApi.setAuthMode(
        'deepseek_harness',
        isOfficial ? 'deepseek' : 'custom',
        next.apiKey.trim() || null
      );
      const savedView = await agentManagementApi.saveDshProvider({
        id: isOfficial ? OFFICIAL_ID : editingId || custom?.id || CUSTOM_ID,
        display_name: isOfficial
          ? 'DeepSeek'
          : next.displayName.trim() || CUSTOM_ID,
        notes: isOfficial ? null : next.notes.trim() || null,
        api: isOfficial ? null : 'openai-completions',
        base_url: isOfficial
          ? next.baseUrl.trim() || OFFICIAL_URL
          : next.baseUrl.trim(),
        api_key: next.apiKey.trim() || null,
        models: next.models,
        set_default: true,
        default_model: next.model.trim() || null,
      });
      setView(savedView);
      setSavedMode(isOfficial ? 'deepseek' : 'custom');
      setCustomSurface('list');
      setEditingId(null);
      clearAgentSettingsDraft(DRAFT_KEY);
      const hydrated = hydrate(savedView, isOfficial ? 'deepseek' : 'custom');
      draftRef.current = hydrated;
      setDraft(hydrated);
      setAvailableModels((current) =>
        mergeModelLists(current, hydrated.models)
      );
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.dshProviderSaveFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  const handleFieldBlur = () => {
    if (skipBlurSaveRef.current || discovering) {
      skipBlurSaveRef.current = false;
      return;
    }
    void save();
  };

  const discover = async () => {
    const isOfficial = draftRef.current.mode !== 'custom';
    const url = isOfficial
      ? draftRef.current.baseUrl.trim() || OFFICIAL_URL
      : draftRef.current.baseUrl.trim();
    if (!url) {
      toast.warning(t('settings:agents.dshProviderUrlRequired'));
      return;
    }
    setDiscovering(true);
    try {
      const discovered = await agentManagementApi.discoverDshModels({
        base_url: url,
        api_key: draftRef.current.apiKey.trim() || null,
        provider_id: isOfficial
          ? OFFICIAL_ID
          : editingId || custom?.id || CUSTOM_ID,
      });
      const models = discovered.length ? discovered : draftRef.current.models;
      setAvailableModels(models);
      const next = {
        ...draftRef.current,
        models,
        model: models.some((entry) => entry.id === draftRef.current.model)
          ? draftRef.current.model
          : (models[0]?.id ?? ''),
      };
      draftRef.current = next;
      setDraft(next);
      void save(next);
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.dshProviderDiscoverFailed'))
      );
    } finally {
      skipBlurSaveRef.current = false;
      setDiscovering(false);
    }
  };

  const patchDraft = (patch: Partial<Draft>, commit = false) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    if (commit) void save(next);
  };

  const toggleAvailableModel = (modelId: string, checked: boolean) => {
    const currentSelectedIds = new Set(
      draftRef.current.models.map((entry) => entry.id)
    );
    if (checked) {
      currentSelectedIds.add(modelId);
    } else {
      currentSelectedIds.delete(modelId);
    }
    const pool = mergeModelLists(availableModels, draftRef.current.models);
    const nextModels = pool.filter((entry) => currentSelectedIds.has(entry.id));
    const nextDefaultModel = nextModels.some(
      (entry) => entry.id === draftRef.current.model
    )
      ? draftRef.current.model
      : (nextModels[0]?.id ?? '');
    patchDraft({ models: nextModels, model: nextDefaultModel }, true);
  };

  const toggleAllAvailableModels = (checked: boolean) => {
    const nextModels = checked ? [...availableModels] : [];
    const nextDefaultModel = nextModels.some(
      (entry) => entry.id === draftRef.current.model
    )
      ? draftRef.current.model
      : (nextModels[0]?.id ?? '');
    patchDraft({ models: nextModels, model: nextDefaultModel }, true);
  };

  const selectedModelIds = useMemo(
    () => new Set(draft.models.map((entry) => entry.id)),
    [draft.models]
  );
  const allAvailableSelected =
    availableModels.length > 0 &&
    availableModels.every((item) => selectedModelIds.has(item.id));

  const modelOptions = draft.models
    .filter((entry) => entry.id.trim())
    .map((entry) => ({
      value: entry.id,
      label: entry.name?.trim() || entry.id,
    }));

  const selectMode = (mode: string) => {
    setCustomSurface('list');
    setEditingId(null);
    setApiKeyRevealed(false);
    const next = view ? hydrate(view, mode) : { ...draftRef.current, mode };
    draftRef.current = next;
    setDraft(next);
    setAvailableModels(next.models);
  };

  const applyCatalogTemplate = (template: ProviderCatalogTemplateView) => {
    const models = (template.models ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name ?? null,
    }));
    setEndpointCandidates(template.endpoint_candidates ?? []);
    setAvailableModels(models);
    const next: Draft = {
      ...draftRef.current,
      mode: 'custom',
      apiKey: '',
      displayName: template.display_name?.trim() || template.name,
      notes: template.notes ?? '',
      baseUrl: template.base_url?.trim() || '',
      models,
      model: template.default_model?.trim() || models[0]?.id || '',
    };
    draftRef.current = next;
    setDraft(next);
  };

  const openCustomCreate = () => {
    setEditingId(null);
    setEndpointCandidates([]);
    setApiKeyRevealed(false);
    setAvailableModels([]);
    const next: Draft = {
      ...draftRef.current,
      mode: 'custom',
      apiKey: '',
      displayName: '',
      notes: '',
      baseUrl: '',
      model: '',
      models: [],
    };
    draftRef.current = next;
    setDraft(next);
    setCustomSurface('form');
  };

  const openCustomEdit = (providerId: string) => {
    if (!view) return;
    const provider = view.providers.find((entry) => entry.id === providerId);
    if (!provider) return;
    setEditingId(provider.id);
    setEndpointCandidates([]);
    setApiKeyRevealed(false);
    setAvailableModels(provider.models);
    const next: Draft = {
      mode: 'custom',
      apiKey: provider.api_key ?? '',
      displayName: provider.display_name,
      notes: provider.notes ?? '',
      baseUrl: provider.base_url ?? '',
      model:
        view.default_provider === provider.id
          ? view.default_model
          : (provider.models[0]?.id ?? ''),
      models: provider.models,
    };
    draftRef.current = next;
    setDraft(next);
    setCustomSurface('form');
  };

  const enableCustom = async (providerId: string) => {
    const provider = view?.providers.find((entry) => entry.id === providerId);
    if (!provider) return;
    setSaving(true);
    try {
      const next = await agentManagementApi.saveDshProvider({
        id: provider.id,
        display_name: provider.display_name,
        notes: provider.notes,
        api: provider.api,
        base_url: provider.base_url,
        api_key: null,
        models: provider.models,
        set_default: true,
        default_model: provider.models[0]?.id ?? view?.default_model ?? null,
      });
      await agentManagementApi.setAuthMode('deepseek_harness', 'custom', null);
      setView(next);
      setSavedMode('custom');
      const hydrated = hydrate(next, 'custom');
      draftRef.current = hydrated;
      setDraft(hydrated);
      setAvailableModels(hydrated.models);
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.dshProviderSaveFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  const removeCustom = async (providerId: string, name: string) => {
    const result = await ConfirmDialog.show({
      title: t('settings:agents.providerDeleteTitle', { name }),
      message: t('settings:agents.providerDeleteMessage'),
      confirmText: t('settings:agents.providerDeleteConfirm'),
      cancelText: t('common:cancel'),
      variant: 'destructive',
    });
    if (result !== 'confirmed') return;
    setSaving(true);
    try {
      setView(await agentManagementApi.deleteDshProvider(providerId));
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.dshProviderSaveFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  const moveTabFocus = (current: string, delta: number) => {
    const index = AUTH_TABS.findIndex((tab) => tab.value === current);
    const next =
      AUTH_TABS[(index + delta + AUTH_TABS.length) % AUTH_TABS.length];
    document
      .getElementById(`deepseek_harness-auth-mode-${next.value}`)
      ?.focus();
  };

  const renderSecretKeyInput = (credentialPresent?: boolean) => (
    <label className="agent-auth-mode-field">
      <span>{t('settings:agents.dshProviderApiKey')}</span>
      <div className="agent-model-provider-secret">
        <TextInput
          label={t('settings:agents.dshProviderApiKey')}
          isLabelHidden
          type={apiKeyRevealed ? 'text' : 'password'}
          htmlName="dsh_api_key"
          placeholder={
            credentialPresent
              ? t('settings:agents.credentialSavedPlaceholder')
              : t('settings:agents.credentialPlaceholder')
          }
          value={draft.apiKey}
          onBlur={handleFieldBlur}
          onChange={(value) => patchDraft({ apiKey: value })}
          width="100%"
          className="[&_input]:pr-9 [&_input]:text-sm"
        />
        <Button
          size="sm"
          type="button"
          variant="ghost"
          className="h-8 w-8 p-0"
          aria-label={
            apiKeyRevealed
              ? t('settings:agents.providerHideKey')
              : t('settings:agents.providerShowKey')
          }
          disabled={saving || !draft.apiKey}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setApiKeyRevealed((current) => !current)}
        >
          {apiKeyRevealed ? (
            <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Eye aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>
    </label>
  );

  const renderModelSelection = () => (
    <>
      <div className="agent-model-provider-detection">
        <div className="provider-detected-models-heading">
          <span className="provider-detected-models-title">
            {t('settings:agents.providerDetectedModels')}
          </span>
          <Button
            className="h-8"
            aria-busy={discovering}
            disabled={discovering || saving}
            size="sm"
            type="button"
            variant="outline"
            onMouseDown={() => {
              skipBlurSaveRef.current = true;
            }}
            onClick={() => void discover()}
          >
            {discovering ? (
              <Loader2
                aria-hidden="true"
                className="mr-1.5 h-3.5 w-3.5 animate-spin"
              />
            ) : (
              <ScanSearch aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t('settings:agents.dshProviderFetchModels')}
          </Button>
          {discovering ? (
            <p aria-live="polite">
              {t('settings:agents.providerDetectingModels')}
            </p>
          ) : availableModels.length > 0 ? (
            <p aria-live="polite">
              {t('settings:agents.providerDetectedModelCount', {
                count: availableModels.length,
              })}
            </p>
          ) : null}
          {availableModels.length > 0 ? (
            <div className="provider-detected-models-heading-actions">
              <Button
                size="sm"
                type="button"
                variant="ghost"
                className="h-7"
                disabled={saving || discovering || allAvailableSelected}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggleAllAvailableModels(true)}
              >
                {t('settings:agents.providerDetectedSelectAll')}
              </Button>
              <Button
                size="sm"
                type="button"
                variant="ghost"
                className="h-7"
                disabled={
                  saving || discovering || selectedModelIds.size === 0
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => toggleAllAvailableModels(false)}
              >
                {t('settings:agents.providerDetectedClear')}
              </Button>
            </div>
          ) : null}
        </div>
        {availableModels.length > 0 ? (
          <div
            className="provider-detected-models"
            role="group"
            aria-label={t('settings:agents.providerDetectedModels')}
          >
            {availableModels.map((item) => {
              const displayLabel = item.name?.trim() || item.id;
              return (
                <label key={item.id}>
                  <input
                    type="checkbox"
                    checked={selectedModelIds.has(item.id)}
                    disabled={saving || discovering}
                    name={`detected_model_${item.id}`}
                    onChange={(event) =>
                      toggleAvailableModel(item.id, event.target.checked)
                    }
                  />
                  <span>
                    <strong>{displayLabel}</strong>
                    {item.name && item.name.trim() !== item.id ? (
                      <code title={item.id}>{item.id}</code>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        ) : null}
      </div>
      <label className="agent-auth-mode-field">
        <span>{t('settings:agents.dshProviderDefaultModel')}</span>
        {modelOptions.length ? (
          <AstryxSelect
            ariaLabel={t('settings:agents.dshProviderDefaultModel')}
            options={modelOptions}
            value={draft.model}
            onChange={(model) => patchDraft({ model }, true)}
          />
        ) : (
          <TextInput
            label={t('settings:agents.dshProviderDefaultModel')}
            isLabelHidden
            htmlName="dsh_model"
            value={draft.model}
            onBlur={handleFieldBlur}
            onChange={(value) => patchDraft({ model: value })}
            width="100%"
            className="[&_input]:text-sm"
          />
        )}
      </label>
    </>
  );

  return (
    <>
      <section
        aria-labelledby="dsh-auth-heading"
        className="settings-surface agent-auth-mode-surface"
      >
        <div className="agent-section-heading">
          <h3 id="dsh-auth-heading">{t('settings:agents.authTitle')}</h3>
          {view ? (
            <div className="agent-auth-mode-heading-tools">
              <div
                className="agent-auth-mode-tabs astryx-segmented-control"
                role="tablist"
                aria-label={t('settings:agents.authModeAria', {
                  agent: 'DeepSeek Harness',
                })}
              >
                {AUTH_TABS.map((tab) => {
                  const selected = draft.mode === tab.value;
                  const unsaved = selected && tab.value !== savedMode;
                  const fullLabel = t(tab.labelKey);
                  const TabIcon = tab.Icon;
                  return (
                    <button
                      key={tab.value}
                      id={`deepseek_harness-auth-mode-${tab.value}`}
                      type="button"
                      role="tab"
                      aria-label={fullLabel}
                      aria-selected={selected}
                      aria-controls="deepseek_harness-auth-mode-panel"
                      tabIndex={selected ? 0 : -1}
                      className={cn(
                        'astryx-segmented-control-item',
                        selected && 'is-active',
                        unsaved && 'is-draft'
                      )}
                      disabled={saving}
                      onClick={() => selectMode(tab.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowRight') {
                          event.preventDefault();
                          moveTabFocus(tab.value, 1);
                        } else if (event.key === 'ArrowLeft') {
                          event.preventDefault();
                          moveTabFocus(tab.value, -1);
                        } else if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          selectMode(tab.value);
                        }
                      }}
                    >
                      <TabIcon
                        aria-hidden="true"
                        className="agent-auth-mode-tab-icon"
                      />
                      <span>{fullLabel}</span>
                      {unsaved ? (
                        <span
                          className="agent-auth-mode-tab-draft"
                          aria-label={t('settings:agents.authModeUnsaved')}
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>
        <div className="agent-auth-mode-frame">
          {loading && !view ? (
            <p className="agent-plugin-empty">
              {t('settings:agents.dshProviderLoading')}
            </p>
          ) : (
            <div
              id="deepseek_harness-auth-mode-panel"
              className="agent-auth-mode-body dsh-auth-fields"
              role="tabpanel"
            >
              {officialMode ? (
                <>
                  <label className="agent-auth-mode-field">
                    <span>API URL</span>
                    <AstryxSelect
                      ariaLabel="API URL"
                      disabled={saving}
                      options={OFFICIAL_URLS.map((url) => ({
                        value: url,
                        label: url,
                      }))}
                      value={
                        OFFICIAL_URLS.includes(
                          draft.baseUrl as (typeof OFFICIAL_URLS)[number]
                        )
                          ? draft.baseUrl
                          : OFFICIAL_URL
                      }
                      onChange={(value) => patchDraft({ baseUrl: value }, true)}
                    />
                  </label>
                  {renderSecretKeyInput(official?.credential_present)}
                  {renderModelSelection()}
                </>
              ) : customSurface === 'form' ? (
                <div className="agent-model-provider-form">
                  <div className="agent-model-provider-form-heading">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8"
                      onClick={() => {
                        setEndpointCandidates([]);
                        setApiKeyRevealed(false);
                        setCustomSurface('list');
                        if (view) {
                          const next = hydrate(view, 'custom');
                          draftRef.current = next;
                          setDraft(next);
                          setAvailableModels(next.models);
                        }
                      }}
                    >
                      <ArrowLeft
                        aria-hidden="true"
                        className="mr-1.5 h-3.5 w-3.5"
                      />
                      {t('settings:agents.providerFormBack')}
                    </Button>
                    <strong>
                      {editingId
                        ? t('settings:agents.providerEdit')
                        : t('settings:agents.providerNew')}
                    </strong>
                  </div>
                  {!editingId && hasCatalogContributions ? (
                    <ProviderCatalogPicker
                      disabled={saving}
                      generation={catalog?.generation ?? catalogGeneration}
                      showCustomTile
                      templates={catalog?.templates ?? []}
                      onSelect={(next) => {
                        if (next === 'custom') {
                          setEndpointCandidates([]);
                          setAvailableModels([]);
                          const cleared: Draft = {
                            ...draftRef.current,
                            apiKey: '',
                            displayName: '',
                            notes: '',
                            baseUrl: '',
                            model: '',
                            models: [],
                          };
                          draftRef.current = cleared;
                          setDraft(cleared);
                          return;
                        }
                        applyCatalogTemplate(next);
                      }}
                    />
                  ) : null}
                  {catalogError ? (
                    <p className="agent-model-provider-error" role="alert">
                      {catalogError}
                    </p>
                  ) : null}
                  <label className="agent-auth-mode-field">
                    <span>{t('settings:agents.dshProviderName')}</span>
                    <TextInput
                      label={t('settings:agents.dshProviderName')}
                      isLabelHidden
                      htmlName="dsh_custom_name"
                      value={draft.displayName}
                      onBlur={handleFieldBlur}
                      onChange={(value) => patchDraft({ displayName: value })}
                      width="100%"
                      className="[&_input]:text-sm"
                    />
                  </label>
                  <label className="agent-auth-mode-field">
                    <span>{t('settings:agents.dshProviderNotes')}</span>
                    <TextInput
                      label={t('settings:agents.dshProviderNotes')}
                      isLabelHidden
                      htmlName="dsh_custom_notes"
                      value={draft.notes}
                      onBlur={handleFieldBlur}
                      onChange={(value) => patchDraft({ notes: value })}
                      width="100%"
                      className="[&_input]:text-sm"
                    />
                  </label>
                  <label className="agent-auth-mode-field">
                    <span>API URL</span>
                    <TextInput
                      label={t('settings:agents.dshProviderBaseUrl')}
                      isLabelHidden
                      htmlName="dsh_custom_url"
                      value={draft.baseUrl}
                      onBlur={handleFieldBlur}
                      onChange={(value) => patchDraft({ baseUrl: value })}
                      width="100%"
                      className="[&_input]:text-sm"
                    />
                  </label>
                  {endpointCandidates.length > 1 ? (
                    <AstryxSelect
                      disabled={saving}
                      options={endpointCandidates.map((candidate) => ({
                        value: candidate,
                        label: candidate,
                      }))}
                      value={draft.baseUrl}
                      onChange={(value) => patchDraft({ baseUrl: value }, true)}
                    />
                  ) : null}
                  {renderSecretKeyInput(editingCustom?.credential_present)}
                  {renderModelSelection()}
                </div>
              ) : (
                <div className="agent-model-provider-manager is-embedded">
                  <div className="agent-model-provider-heading">
                    <h4 id="deepseek_harness-model-provider-heading">
                      {t('settings:agents.providerTitle')}
                    </h4>
                    <div className="agent-model-provider-toolbar">
                      <Button
                        size="sm"
                        className="h-8"
                        disabled={saving || locked}
                        onClick={openCustomCreate}
                      >
                        <Plus
                          aria-hidden="true"
                          className="mr-1.5 h-3.5 w-3.5"
                        />
                        {t('settings:agents.providerCreateButton')}
                      </Button>
                    </div>
                  </div>
                  {customProviders.length ? (
                    <ul className="agent-model-provider-list">
                      {customProviders.map((provider) => {
                        const bound = view?.default_provider === provider.id;
                        return (
                          <li key={provider.id} data-bound={bound}>
                            <div>
                              <strong>{provider.display_name}</strong>
                              <p>{provider.base_url ?? ''}</p>
                            </div>
                            <div className="agent-model-provider-card-actions">
                              <Button
                                size="sm"
                                variant={bound ? 'outline' : 'default'}
                                className="h-7"
                                disabled={saving || bound || locked}
                                onClick={() => void enableCustom(provider.id)}
                              >
                                {bound ? (
                                  <Check
                                    aria-hidden="true"
                                    className="mr-1 h-3.5 w-3.5"
                                  />
                                ) : null}
                                {bound
                                  ? t('settings:agents.enabled')
                                  : t('settings:agents.providerEnable')}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7"
                                disabled={saving || locked}
                                onClick={() => openCustomEdit(provider.id)}
                              >
                                <Pencil
                                  aria-hidden="true"
                                  className="h-3.5 w-3.5"
                                />
                                {t('settings:agents.providerEdit')}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7"
                                disabled={saving || bound || locked}
                                onClick={() =>
                                  void removeCustom(
                                    provider.id,
                                    provider.display_name
                                  )
                                }
                              >
                                <Trash2
                                  aria-hidden="true"
                                  className="h-3.5 w-3.5"
                                />
                              </Button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="agent-plugin-empty">
                      {t('agents.providerEmpty')}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function mergeModelLists(
  primary: DshProviderModelView[],
  secondary: DshProviderModelView[]
): DshProviderModelView[] {
  const seen = new Set<string>();
  const merged: DshProviderModelView[] = [];
  for (const item of [...primary, ...secondary]) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  return merged;
}

function emptyDraft(mode: string): Draft {
  return {
    mode,
    apiKey: '',
    displayName: '',
    notes: '',
    baseUrl: mode === 'custom' ? '' : OFFICIAL_URL,
    model: '',
    models: [],
  };
}

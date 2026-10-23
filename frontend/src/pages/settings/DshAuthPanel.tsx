import {
  ArrowLeft,
  Check,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Search,
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
  const [draft, setDraft] = useState<Draft>(
    () => peekAgentSettingsDraft<Draft>(DRAFT_KEY) ?? emptyDraft('deepseek')
  );
  const draftRef = useRef(draft);
  draftRef.current = draft;
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
    if (mode !== 'custom') {
      return {
        mode: 'deepseek',
        apiKey: '',
        displayName: officialProvider?.display_name ?? 'DeepSeek',
        notes: '',
        baseUrl: OFFICIAL_URL,
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
      officialCustomUrl !== OFFICIAL_URL;
    return {
      mode: 'custom',
      apiKey: '',
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
      setDraft(
        peekAgentSettingsDraft<Draft>(DRAFT_KEY) ?? hydrate(next, auth.mode)
      );
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

  const saved = view ? hydrate(view, savedMode) : emptyDraft(savedMode);
  const dirty = useMemo(() => {
    if (!view) return false;
    return (
      draft.mode !== saved.mode ||
      draft.apiKey.trim().length > 0 ||
      draft.displayName !== saved.displayName ||
      draft.notes !== saved.notes ||
      draft.baseUrl !== saved.baseUrl ||
      draft.model !== saved.model
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

  const discover = async () => {
    const url = officialMode ? OFFICIAL_URL : draft.baseUrl.trim();
    if (!url) {
      toast.warning(t('settings:agents.dshProviderUrlRequired'));
      return;
    }
    setDiscovering(true);
    try {
      const discovered = await agentManagementApi.discoverDshModels({
        base_url: url,
        api_key: draft.apiKey.trim() || null,
        provider_id: officialMode ? OFFICIAL_ID : custom?.id || CUSTOM_ID,
      });
      const models = discovered.length ? discovered : draftRef.current.models;
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
      setDiscovering(false);
    }
  };

  const draftChanged = (next: Draft) => {
    if (!view) return false;
    const baseline = hydrate(view, savedMode);
    return (
      next.mode !== baseline.mode ||
      next.apiKey.trim().length > 0 ||
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
      isOfficial ? official?.credential_present : custom?.credential_present
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
      const saved = await agentManagementApi.saveDshProvider({
        id: isOfficial ? OFFICIAL_ID : editingId || custom?.id || CUSTOM_ID,
        display_name: isOfficial
          ? 'DeepSeek'
          : next.displayName.trim() || CUSTOM_ID,
        notes: isOfficial ? null : next.notes.trim() || null,
        api: isOfficial ? null : 'openai-completions',
        base_url: isOfficial ? null : next.baseUrl.trim(),
        api_key: next.apiKey.trim() || null,
        models: next.models,
        set_default: true,
        default_model: next.model.trim() || null,
      });
      setView(saved);
      setSavedMode(isOfficial ? 'deepseek' : 'custom');
      setCustomSurface('list');
      setEditingId(null);
      clearAgentSettingsDraft(DRAFT_KEY);
      const hydrated = hydrate(saved, isOfficial ? 'deepseek' : 'custom');
      draftRef.current = hydrated;
      setDraft(hydrated);
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.dshProviderSaveFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  const patchDraft = (patch: Partial<Draft>, commit = false) => {
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
    if (commit) void save(next);
  };

  const modelOptions = draft.models
    .filter((entry) => entry.id.trim())
    .map((entry) => ({
      value: entry.id,
      label: entry.name?.trim() || entry.id,
    }));

  const selectMode = (mode: string) => {
    setCustomSurface('list');
    setEditingId(null);
    const next = view ? hydrate(view, mode) : { ...draftRef.current, mode };
    draftRef.current = next;
    setDraft(next);
  };

  const applyCatalogTemplate = (template: ProviderCatalogTemplateView) => {
    const models = (template.models ?? []).map((entry) => ({
      id: entry.id,
      name: entry.name ?? null,
    }));
    setEndpointCandidates(template.endpoint_candidates ?? []);
    setDraft((current) => ({
      ...current,
      mode: 'custom',
      apiKey: '',
      displayName: template.display_name?.trim() || template.name,
      notes: template.notes ?? '',
      baseUrl: template.base_url?.trim() || '',
      models,
      model: template.default_model?.trim() || models[0]?.id || '',
    }));
  };

  const openCustomCreate = () => {
    setEditingId(null);
    setEndpointCandidates([]);
    setDraft((current) => ({
      ...current,
      mode: 'custom',
      apiKey: '',
      displayName: '',
      notes: '',
      baseUrl: '',
      model: '',
      models: [],
    }));
    setCustomSurface('form');
  };

  const openCustomEdit = (providerId: string) => {
    if (!view) return;
    const provider = view.providers.find((entry) => entry.id === providerId);
    if (!provider) return;
    setEditingId(provider.id);
    setEndpointCandidates([]);
    setDraft({
      mode: 'custom',
      apiKey: '',
      displayName: provider.display_name,
      notes: provider.notes ?? '',
      baseUrl: provider.base_url ?? '',
      model:
        view.default_provider === provider.id
          ? view.default_model
          : (provider.models[0]?.id ?? ''),
      models: provider.models,
    });
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
      setDraft(hydrate(next, 'custom'));
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
                    <TextInput
                      ref={(input) => {
                        if (input) input.readOnly = true;
                      }}
                      label="API URL"
                      isLabelHidden
                      value={OFFICIAL_URL}
                      onChange={() => undefined}
                      width="100%"
                      className="[&_input]:text-sm"
                    />
                  </label>
                  <label className="agent-auth-mode-field">
                    <span>{t('settings:agents.dshProviderApiKey')}</span>
                    <TextInput
                      label={t('settings:agents.dshProviderApiKey')}
                      isLabelHidden
                      type="password"
                      htmlName="dsh_api_key"
                      placeholder={
                        official?.credential_present
                          ? t('settings:agents.credentialSavedPlaceholder')
                          : t('settings:agents.credentialPlaceholder')
                      }
                      value={draft.apiKey}
                      onBlur={() => void save()}
                      onChange={(value) => patchDraft({ apiKey: value })}
                      width="100%"
                      className="[&_input]:text-sm"
                    />
                  </label>
                  <div className="dsh-auth-model-row">
                    <label className="agent-auth-mode-field">
                      <span>
                        {t('settings:agents.dshProviderDefaultModel')}
                      </span>
                      {modelOptions.length ? (
                        <AstryxSelect
                          ariaLabel={t(
                            'settings:agents.dshProviderDefaultModel'
                          )}
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
                          onBlur={() => void save()}
                          onChange={(value) => patchDraft({ model: value })}
                          width="100%"
                          className="[&_input]:text-sm"
                        />
                      )}
                    </label>
                    <Button
                      className="h-8"
                      disabled={discovering || saving}
                      size="sm"
                      type="button"
                      variant="outline"
                      onClick={() => void discover()}
                    >
                      {discovering ? (
                        <Loader2
                          aria-hidden="true"
                          className="h-3.5 w-3.5 animate-spin"
                        />
                      ) : (
                        <Search aria-hidden="true" className="h-3.5 w-3.5" />
                      )}
                      {t('settings:agents.dshProviderFetchModels')}
                    </Button>
                  </div>
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
                        setCustomSurface('list');
                        if (view) setDraft(hydrate(view, 'custom'));
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
                          setDraft((current) => ({
                            ...current,
                            apiKey: '',
                            displayName: '',
                            notes: '',
                            baseUrl: '',
                            model: '',
                            models: [],
                          }));
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
                      onBlur={() => void save()}
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
                      onBlur={() => void save()}
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
                      onBlur={() => void save()}
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
                  <label className="agent-auth-mode-field">
                    <span>{t('settings:agents.dshProviderApiKey')}</span>
                    <TextInput
                      label={t('settings:agents.dshProviderApiKey')}
                      isLabelHidden
                      type="password"
                      htmlName="dsh_api_key"
                      placeholder={
                        custom?.credential_present
                          ? t('settings:agents.credentialSavedPlaceholder')
                          : t('settings:agents.credentialPlaceholder')
                      }
                      value={draft.apiKey}
                      onBlur={() => void save()}
                      onChange={(value) => patchDraft({ apiKey: value })}
                      width="100%"
                      className="[&_input]:text-sm"
                    />
                  </label>
                  <div className="dsh-auth-model-row">
                    <label className="agent-auth-mode-field">
                      <span>
                        {t('settings:agents.dshProviderDefaultModel')}
                      </span>
                      {modelOptions.length ? (
                        <AstryxSelect
                          ariaLabel={t(
                            'settings:agents.dshProviderDefaultModel'
                          )}
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
                          onBlur={() => void save()}
                          onChange={(value) => patchDraft({ model: value })}
                          width="100%"
                          className="[&_input]:text-sm"
                        />
                      )}
                    </label>
                    <Button
                      className="h-8"
                      disabled={discovering || saving}
                      size="sm"
                      type="button"
                      variant="outline"
                      onClick={() => void discover()}
                    >
                      {discovering ? (
                        <Loader2
                          aria-hidden="true"
                          className="h-3.5 w-3.5 animate-spin"
                        />
                      ) : (
                        <Search aria-hidden="true" className="h-3.5 w-3.5" />
                      )}
                      {t('settings:agents.dshProviderFetchModels')}
                    </Button>
                  </div>
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

import { Loader2, Search, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DshProviderModelView, DshProvidersView } from 'shared/types';

import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

import {
  clearAgentSettingsDraft,
  peekAgentSettingsDraft,
  retainAgentSettingsDraft,
} from './agentSettingsDraftRetention';
import { SettingsActionBar } from './SettingsUi';

const DRAFT_KEY = 'dsh-auth';

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
};

export function DshAuthPanel({ onChanged, onDirtyChange }: Props) {
  const { t } = useTranslation(['settings', 'common']);
  const [view, setView] = useState<DshProvidersView | null>(null);
  const [savedMode, setSavedMode] = useState('deepseek');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [draft, setDraft] = useState<Draft>(
    () => peekAgentSettingsDraft<Draft>(DRAFT_KEY) ?? emptyDraft('deepseek')
  );

  const official = view?.providers.find(
    (provider) => provider.id === OFFICIAL_ID
  );
  const custom = view?.providers.find((provider) => provider.kind === 'custom');
  const officialMode = draft.mode !== 'custom';

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
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);

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
      const next = discovered.length ? discovered : draft.models;
      setDraft((current) => ({
        ...current,
        models: next,
        model: next.some((entry) => entry.id === current.model)
          ? current.model
          : (next[0]?.id ?? ''),
      }));
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.dshProviderDiscoverFailed'))
      );
    } finally {
      setDiscovering(false);
    }
  };

  const discard = () => {
    clearAgentSettingsDraft(DRAFT_KEY);
    if (view) setDraft(hydrate(view, savedMode));
  };

  const save = async () => {
    if (!officialMode && !draft.baseUrl.trim()) {
      toast.warning(t('settings:agents.dshProviderUrlRequired'));
      return;
    }
    if (
      !draft.apiKey.trim() &&
      !(officialMode
        ? official?.credential_present
        : custom?.credential_present)
    ) {
      toast.warning(t('settings:agents.dshProviderKeyRequired'));
      return;
    }
    setSaving(true);
    try {
      await agentManagementApi.setAuthMode(
        'deepseek_harness',
        officialMode ? 'deepseek' : 'custom',
        draft.apiKey.trim() || null
      );
      const next = await agentManagementApi.saveDshProvider({
        id: officialMode ? OFFICIAL_ID : custom?.id || CUSTOM_ID,
        display_name: officialMode
          ? 'DeepSeek'
          : draft.displayName.trim() || CUSTOM_ID,
        notes: officialMode ? null : draft.notes.trim() || null,
        api: officialMode ? null : 'openai-completions',
        base_url: officialMode ? null : draft.baseUrl.trim(),
        api_key: draft.apiKey.trim() || null,
        models: draft.models,
        set_default: true,
        default_model: draft.model.trim() || null,
      });
      setView(next);
      setSavedMode(officialMode ? 'deepseek' : 'custom');
      clearAgentSettingsDraft(DRAFT_KEY);
      setDraft(hydrate(next, officialMode ? 'deepseek' : 'custom'));
      await onChanged?.();
    } catch (error) {
      toast.error(
        errorMessage(error, t('settings:agents.dshProviderSaveFailed'))
      );
    } finally {
      setSaving(false);
    }
  };

  const modelOptions = draft.models
    .filter((entry) => entry.id.trim())
    .map((entry) => ({
      value: entry.id,
      label: entry.name?.trim() || entry.id,
    }));

  return (
    <>
      <section aria-labelledby="dsh-auth-heading" className="settings-surface">
        <div className="agent-section-heading">
          <div className="flex items-center gap-2">
            <ShieldCheck aria-hidden="true" className="h-4 w-4" />
            <h3 id="dsh-auth-heading">{t('settings:agents.authTitle')}</h3>
          </div>
        </div>
        {loading && !view ? (
          <p className="agent-plugin-empty">
            {t('settings:agents.dshProviderLoading')}
          </p>
        ) : (
          <div className="dsh-auth-fields">
            <label className="agent-auth-mode-field">
              <span>
                {t('settings:agents.authModeLabel', {
                  agent: 'DeepSeek Harness',
                })}
              </span>
              <AstryxSelect
                ariaLabel={t('settings:agents.authModeAria', {
                  agent: 'DeepSeek Harness',
                })}
                options={[
                  {
                    value: 'deepseek',
                    label: t('settings:agents.authModeDeepseekApi'),
                  },
                  {
                    value: 'custom',
                    label: t('settings:agents.authModeCustomEndpoint'),
                  },
                ]}
                value={draft.mode}
                onChange={(mode) =>
                  setDraft((current) =>
                    view ? hydrate(view, mode) : { ...current, mode }
                  )
                }
              />
            </label>
            {officialMode ? (
              <label className="agent-auth-mode-field">
                <span>{t('settings:agents.dshProviderBaseUrl')}</span>
                <Input readOnly value={OFFICIAL_URL} />
              </label>
            ) : (
              <>
                <label className="agent-auth-mode-field">
                  <span>{t('settings:agents.dshProviderName')}</span>
                  <Input
                    autoComplete="off"
                    name="dsh_custom_name"
                    value={draft.displayName}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        displayName: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="agent-auth-mode-field">
                  <span>{t('settings:agents.dshProviderNotes')}</span>
                  <Input
                    autoComplete="off"
                    name="dsh_custom_notes"
                    value={draft.notes}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        notes: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="agent-auth-mode-field">
                  <span>{t('settings:agents.dshProviderBaseUrl')}</span>
                  <Input
                    autoComplete="off"
                    name="dsh_custom_url"
                    value={draft.baseUrl}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        baseUrl: event.target.value,
                      }))
                    }
                  />
                </label>
              </>
            )}
            <label className="agent-auth-mode-field">
              <span>{t('settings:agents.dshProviderApiKey')}</span>
              <Input
                aria-label={t('settings:agents.dshProviderApiKey')}
                autoComplete="new-password"
                name="dsh_api_key"
                placeholder={
                  (
                    officialMode
                      ? official?.credential_present
                      : custom?.credential_present
                  )
                    ? t('settings:agents.credentialSavedPlaceholder')
                    : t('settings:agents.credentialPlaceholder')
                }
                type="password"
                value={draft.apiKey}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    apiKey: event.target.value,
                  }))
                }
              />
            </label>
            <div className="dsh-auth-model-row">
              <label className="agent-auth-mode-field">
                <span>{t('settings:agents.dshProviderDefaultModel')}</span>
                {modelOptions.length ? (
                  <AstryxSelect
                    ariaLabel={t('settings:agents.dshProviderDefaultModel')}
                    options={modelOptions}
                    value={draft.model}
                    onChange={(model) =>
                      setDraft((current) => ({ ...current, model }))
                    }
                  />
                ) : (
                  <Input
                    autoComplete="off"
                    name="dsh_model"
                    value={draft.model}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        model: event.target.value,
                      }))
                    }
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
        )}
      </section>
      <SettingsActionBar
        dirty={dirty}
        saving={saving}
        onDiscard={discard}
        onSave={() => void save()}
      />
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

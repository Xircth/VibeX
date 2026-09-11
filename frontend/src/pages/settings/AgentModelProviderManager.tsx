import {
  ArrowLeft,
  Check,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  ScanSearch,
  Timer,
  Trash2,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentId,
  AgentModelCatalogView,
  AgentModelProviderImportCandidateView,
  AgentModelProviderImportPreviewView,
  AgentModelProviderImportSource,
  AgentModelProviderProbeView,
  AgentModelProviderView,
  AgentModelProvidersView,
  CodexModelCatalogConfigRequest,
  CodexModelCatalogConfigView,
} from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { contributionIconComponent } from '@/components/plugins/contributionIcon';
import { AstryxSelect } from '@/components/ui/astryx-select';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import {
  createPluginControlApi,
  type PluginContributionCatalogItem,
} from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';
import { cn } from '@/lib/utils';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';

import {
  CodexModelConfigFields,
  type CustomModelTestState,
} from './CodexModelCatalogEditor';

// `model` fields hold a model id and can be picked from the detected catalog;
// `text` fields (the custom option's display name and description) are prose.
const CLAUDE_MODEL_FIELDS = [
  ['main', 'providerModelMain', 'model'],
  ['reasoning', 'providerModelReasoning', 'model'],
  ['haiku', 'providerModelHaiku', 'model'],
  ['sonnet', 'providerModelSonnet', 'model'],
  ['opus', 'providerModelOpus', 'model'],
  ['customOption', 'providerModelCustomId', 'model'],
  ['customOptionName', 'providerModelCustomName', 'text'],
  ['customOptionDescription', 'providerModelCustomDescription', 'text'],
] as const;

type Surface = 'list' | 'form';

function customModelVerified(state: CustomModelTestState | undefined) {
  return typeof state === 'object' && state.ok;
}

export function AgentModelProviderManager({
  agentId,
  disabled,
  onDirtyChange,
  onChanged,
  embedded = false,
}: {
  agentId: AgentId;
  disabled: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onChanged?: () => void | Promise<void>;
  embedded?: boolean;
}) {
  const { t } = useTranslation(['settings', 'common']);
  const [view, setView] = useState<AgentModelProvidersView | null>(null);
  const [codexCatalog, setCodexCatalog] =
    useState<AgentModelCatalogView | null>(null);
  const [codexConfig, setCodexConfig] =
    useState<CodexModelCatalogConfigView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [surface, setSurface] = useState<Surface>('list');
  const [id, setId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [detectedCatalog, setDetectedCatalog] =
    useState<AgentModelCatalogView | null>(null);
  const [detectingModels, setDetectingModels] = useState(false);
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const [customModelTests, setCustomModelTests] = useState<
    Record<number, CustomModelTestState>
  >({});
  const [claudeMappingTarget, setClaudeMappingTarget] = useState('main');
  const [importOpen, setImportOpen] = useState(false);
  const transport = useBackendTransport();
  const pluginApi = useMemo(
    () => createPluginControlApi(transport),
    [transport]
  );
  const importContributions = usePluginHostContributions(
    'provider_import_source'
  );
  // A source that names agents only shows up for those agents; naming none
  // means it can read any agent's layout.
  const pluginImportSources = useMemo(
    () =>
      importContributions.filter((item) => {
        const agents = contributionMetadata(item).agents;
        if (!Array.isArray(agents) || agents.length === 0) return true;
        return agents.includes(agentId);
      }),
    [importContributions, agentId]
  );
  const [importPreview, setImportPreview] = useState<ImportPreviewModel | null>(
    null
  );
  const [importSelected, setImportSelected] = useState<string[]>([]);
  const [probes, setProbes] = useState<
    Record<string, AgentModelProviderProbeView | 'loading'>
  >({});
  const formDirty = Boolean(id || name || apiUrl || apiKey || model);

  useEffect(() => {
    onDirtyChange?.(formDirty);
    return () => onDirtyChange?.(false);
  }, [formDirty, onDirtyChange]);

  useEffect(() => {
    setView(null);
    setCodexCatalog(null);
    setCodexConfig(null);
    setLoaded(false);
    setLoading(false);
    setSaving(false);
    setError(null);
    setSurface('list');
    setImportOpen(false);
    setImportPreview(null);
    setImportSelected([]);
    setProbes({});
    resetForm();
  }, [agentId]);

  const load = useCallback(async () => {
    if (loaded || loading) return;
    setLoading(true);
    setError(null);
    try {
      const providers = await agentManagementApi.modelProviders(agentId);
      setView(providers);
      setLoaded(true);
      if (agentId === 'codex') {
        void Promise.all([
          agentManagementApi.codexModelCatalog(false).catch(() => null),
          agentManagementApi.codexModelCatalogConfig().catch(() => null),
        ]).then(([catalog, modelConfig]) => {
          setCodexCatalog(catalog);
          setCodexConfig(modelConfig);
        });
      }
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
    setCustomModelTests({});
  };

  const openCreate = () => {
    resetForm();
    setSurface('form');
  };

  const openEdit = (provider: AgentModelProviderView) => {
    setId(provider.id);
    setName(provider.name);
    setApiUrl(provider.api_url);
    setApiKey(provider.api_key);
    setModel(provider.model);
    setDetectedCatalog(null);
    setDetectionError(null);
    setSurface('form');
    if (provider.api_url.trim() && provider.api_key.trim()) {
      void detectModels(
        provider.api_url.trim(),
        provider.api_key.trim(),
        provider.id
      );
    }
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
    setSurface('list');
  };

  const detectModels = async (
    nextUrl = apiUrl.trim(),
    nextKey = apiKey.trim() || null,
    nextId = id
  ) => {
    setDetectingModels(true);
    setDetectionError(null);
    try {
      const catalog = await agentManagementApi.modelProviderCatalog(
        agentId,
        nextId,
        nextUrl,
        nextKey
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

  const toggleDetectedModel = (modelId: string, checked: boolean) => {
    const detected = detectedCatalog?.models.find(
      (candidate) => candidate.id === modelId
    );
    if (!detected) return;
    if (agentId === 'claude_code') {
      const next = { ...parseClaudeModel(model).raw };
      if (checked) {
        next[claudeMappingTarget] = detected.id;
      } else {
        for (const key of Object.keys(next)) {
          if (next[key] === detected.id) delete next[key];
        }
      }
      setModel(Object.keys(next).length ? JSON.stringify(next) : '');
      return;
    }
    if (agentId === 'codex') {
      const draft = mergeCodexConfigDraft(parseCodexModel(model), codexConfig);
      const index = draft.customs.findIndex(
        (candidate) => candidate.slug === detected.id
      );
      if (checked) {
        if (index < 0) {
          const base =
            codexCatalog?.models[0]?.id ??
            detectedCatalog?.models[0]?.id ??
            detected.id;
          draft.customs = [
            ...draft.customs,
            {
              slug: detected.id,
              display_name: detected.label,
              context_window: detected.context_window,
              base,
            },
          ];
          setCustomModelTests((current) => ({
            ...current,
            [draft.customs.length - 1]: { ok: true },
          }));
        }
        if (!draft.default_model) draft.default_model = detected.id;
      } else if (index >= 0) {
        draft.customs = draft.customs.filter(
          (_, customIndex) => customIndex !== index
        );
        setCustomModelTests((current) =>
          reindexCustomModelTests(current, index)
        );
        if (draft.default_model === detected.id) {
          draft.default_model = draft.customs[0]?.slug ?? null;
        }
      }
      setModel(serializeCodexModel(draft));
      return;
    }
    const currentIds = selectedModelIds(model);
    const nextIds = checked
      ? currentIds.includes(detected.id)
        ? currentIds
        : [...currentIds, detected.id]
      : currentIds.filter((id) => id !== detected.id);
    setModel(serializeSelectedModels(agentId, model, nextIds));
  };

  const toggleAllDetected = (checked: boolean) => {
    const models = detectedCatalog?.models ?? [];
    if (agentId === 'claude_code') {
      const next = { ...parseClaudeModel(model).raw };
      const detectedIds = new Set(models.map((item) => item.id));
      if (checked) {
        if (models[0]) next[claudeMappingTarget] = models[0].id;
      } else {
        for (const key of Object.keys(next)) {
          const value = next[key];
          if (typeof value === 'string' && detectedIds.has(value)) {
            delete next[key];
          }
        }
      }
      setModel(Object.keys(next).length ? JSON.stringify(next) : '');
      return;
    }
    if (agentId === 'codex') {
      const draft = mergeCodexConfigDraft(parseCodexModel(model), codexConfig);
      const detectedIds = new Set(models.map((item) => item.id));
      const handwritten = draft.customs.filter(
        (custom) => !detectedIds.has(custom.slug)
      );
      const selected = checked
        ? models.map((item) => ({
            slug: item.id,
            display_name: item.label,
            context_window: item.context_window,
            base: codexCatalog?.models[0]?.id ?? models[0]?.id ?? item.id,
          }))
        : [];
      const customs = [...selected, ...handwritten];
      const tests: Record<number, CustomModelTestState> = {};
      selected.forEach((_, index) => {
        tests[index] = { ok: true };
      });
      const defaultStillAvailable = Boolean(
        draft.default_model &&
          customs.some((custom) => custom.slug === draft.default_model)
      );
      setCustomModelTests(tests);
      setModel(
        serializeCodexModel({
          ...draft,
          customs,
          default_model: defaultStillAvailable
            ? draft.default_model
            : (customs[0]?.slug ?? null),
        })
      );
      return;
    }
    const currentIds = selectedModelIds(model);
    const detectedIds = models.map((item) => item.id);
    const nextIds = checked
      ? [...new Set([...currentIds, ...detectedIds])]
      : currentIds.filter((id) => !detectedIds.includes(id));
    setModel(serializeSelectedModels(agentId, model, nextIds));
  };

  const testCustomModel = async (index: number, slug: string) => {
    const modelId = slug.trim();
    if (!modelId) {
      toast.warning(t('settings:agents.providerCustomModelTestNeedId'));
      return;
    }
    if (!apiUrl.trim() || !apiKey.trim()) {
      toast.warning(t('settings:agents.providerRequiredFields'));
      return;
    }
    setCustomModelTests((current) => ({ ...current, [index]: 'loading' }));
    try {
      const catalog = await agentManagementApi.modelProviderCatalog(
        agentId,
        id,
        apiUrl.trim(),
        apiKey.trim() || null
      );
      setDetectedCatalog(catalog);
      setDetectionError(catalog.error);
      const available = catalog.models.some(
        (candidate) => candidate.id === modelId
      );
      setCustomModelTests((current) => ({
        ...current,
        [index]: available
          ? { ok: true }
          : {
              ok: false,
              error: t('settings:agents.providerCustomModelTestMissing'),
            },
      }));
      if (available) {
        toast.success(t('settings:agents.providerCustomModelTestOk'));
      } else {
        toast.error(t('settings:agents.providerCustomModelTestMissing'));
      }
    } catch (cause) {
      const message = errorMessage(
        cause,
        t('settings:agents.providerModelDetectionFailed')
      );
      setCustomModelTests((current) => ({
        ...current,
        [index]: { ok: false, error: message },
      }));
      toast.error(message);
    }
  };

  const save = async () => {
    if (!name.trim() || !apiUrl.trim() || (!id && !apiKey.trim())) {
      toast.warning(t('settings:agents.providerRequiredFields'));
      return;
    }
    if (agentId === 'codex') {
      const draft = parseCodexModel(model);
      const detectedIds = new Set(
        (detectedCatalog?.models ?? []).map((item) => item.id)
      );
      const untested = draft.customs.some(
        (custom, index) =>
          Boolean(custom.slug.trim()) &&
          !detectedIds.has(custom.slug.trim()) &&
          !customModelVerified(customModelTests[index])
      );
      if (untested) {
        toast.warning(t('settings:agents.providerCustomModelTestRequired'));
        return;
      }
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
      setSurface('list');
      await onChanged?.();
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

  const bind = async (providerId: string) => {
    setSaving(true);
    setError(null);
    try {
      setView(await agentManagementApi.bindModelProvider(agentId, providerId));
      toast.success(t('settings:agents.providerBound'));
      await onChanged?.();
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
      await onChanged?.();
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

  const copyConfig = async (provider: AgentModelProviderView) => {
    const payload = JSON.stringify(
      {
        agent_id: provider.agent_id,
        name: provider.name,
        api_url: provider.api_url,
        model: parseCopiedModel(provider.model),
      },
      null,
      2
    );
    try {
      await navigator.clipboard.writeText(payload);
      toast.success(t('settings:agents.providerCopied'));
    } catch {
      toast.error(t('settings:agents.providerCopyFailed'));
    }
  };

  const testConnection = async (provider: AgentModelProviderView) => {
    setProbes((current) => ({ ...current, [provider.id]: 'loading' }));
    try {
      const result = await agentManagementApi.probeModelProvider(
        agentId,
        provider.id
      );
      setProbes((current) => ({ ...current, [provider.id]: result }));
      if (result.ok) {
        toast.success(
          t('settings:agents.providerTestOk', { ms: result.latency_ms })
        );
      } else {
        toast.error(
          result.error ??
            t('settings:agents.providerTestFailed', { ms: result.latency_ms })
        );
      }
    } catch (cause) {
      const message = errorMessage(
        cause,
        t('settings:agents.providerActionFailed')
      );
      setProbes((current) => ({
        ...current,
        [provider.id]: { ok: false, latency_ms: 0, error: message },
      }));
      toast.error(message);
    }
  };

  const loadImport = async (source: AgentModelProviderImportSource) => {
    setImportOpen(false);
    setSaving(true);
    setError(null);
    try {
      const preview = await agentManagementApi.previewModelProviderImport(
        agentId,
        source
      );
      setImportPreview({ ...preview, origin: { kind: 'builtin', source } });
      setImportSelected(
        preview.candidates
          .filter((candidate) => !candidate.skip_reason)
          .map((candidate) => candidate.source_id)
      );
      if (preview.error) setError(preview.error);
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

  /**
   * Runs a plugin-contributed import source. The plugin only discovers
   * candidates; nothing is written until the user picks from the same preview
   * the built-in sources use.
   */
  const loadPluginImport = async (item: PluginContributionCatalogItem) => {
    setImportOpen(false);
    setSaving(true);
    setError(null);
    try {
      const metadata = contributionMetadata(item);
      const handler =
        typeof metadata.handler === 'string' ? metadata.handler : item.id;
      const candidates = pluginImportCandidates(
        await pluginApi.invokeContribution(item.pluginId, handler, { agentId }),
        t('settings:agents.providerImportNoKey')
      );
      setImportPreview({
        candidates: candidates.map((candidate) => candidate.view),
        error: candidates.length
          ? null
          : t('settings:agents.providerImportEmpty'),
        origin: {
          kind: 'plugin',
          label: item.label,
          drafts: new Map(
            candidates.map((candidate) => [
              candidate.view.source_id,
              candidate.draft,
            ])
          ),
        },
      });
      setImportSelected(
        candidates
          .filter((candidate) => !candidate.view.skip_reason)
          .map((candidate) => candidate.view.source_id)
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

  const applyImport = async () => {
    if (!importPreview) return;
    setSaving(true);
    setError(null);
    try {
      if (importPreview.origin.kind === 'plugin') {
        const { drafts } = importPreview.origin;
        let latest = view;
        // Saved one at a time through the normal save path, so a plugin's
        // candidates get the same validation as anything typed by hand.
        for (const sourceId of importSelected) {
          const draft = drafts.get(sourceId);
          if (!draft) continue;
          latest = await agentManagementApi.saveModelProvider({
            id: null,
            agent_id: agentId,
            name: draft.name,
            api_url: draft.api_url,
            api_key: draft.api_key,
            model: draft.model,
          });
        }
        setView(latest);
      } else {
        setView(
          await agentManagementApi.importModelProviders({
            agent_id: agentId,
            source: importPreview.origin.source,
            source_ids: importSelected,
          })
        );
      }
      setImportPreview(null);
      setImportSelected([]);
      toast.success(t('settings:agents.providerImported'));
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

  const providers = view?.providers ?? [];
  const busy = disabled || saving;

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
          {id
            ? t('settings:agents.providerEdit')
            : t('settings:agents.providerNew')}
        </strong>
      </div>
      <div className="agent-model-provider-form-grid">
        <label>
          <span>{t('settings:agents.name')}</span>
          <input
            aria-label={t('settings:agents.providerNameAria')}
            autoComplete="off"
            disabled={busy}
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
            disabled={busy}
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
        <ProviderSecretField
          key={id ?? 'create'}
          agentId={agentId}
          disabled={busy}
          value={apiKey}
          onChange={(value) => {
            setApiKey(value);
            setDetectedCatalog(null);
            setDetectionError(null);
          }}
        />
        <ProviderModelDetection
          agentId={agentId}
          catalog={detectedCatalog}
          claudeMappingTarget={claudeMappingTarget}
          disabled={busy || !apiUrl.trim() || !apiKey.trim()}
          error={detectionError}
          loading={detectingModels}
          selectedIds={selectedDetectedIds(
            agentId,
            model,
            detectedCatalog,
            codexConfig
          )}
          onDetect={() => void detectModels()}
          onMappingTargetChange={setClaudeMappingTarget}
          onToggleModel={toggleDetectedModel}
          onToggleAll={toggleAllDetected}
        />
        {agentId === 'claude_code' ? (
          <ClaudeProviderModelEditor
            choices={providerModelChoices(model, detectedCatalog)}
            disabled={busy}
            value={model}
            onChange={setModel}
          />
        ) : agentId === 'grok' ? (
          <GrokProviderModelEditor
            choices={providerModelChoices(model, detectedCatalog)}
            disabled={busy}
            value={model}
            onChange={setModel}
          />
        ) : agentId === 'pi' ? (
          <PiProviderModelEditor
            choices={providerModelChoices(model, detectedCatalog)}
            disabled={busy}
            value={model}
            onChange={setModel}
          />
        ) : agentId === 'codex' ? (
          <div className="agent-model-provider-codex">
            <span>{t('settings:agents.modelCatalog')}</span>
            <div className="codex-model-editor-body">
              <CodexModelConfigFields
                catalog={{
                  agent_id: 'codex',
                  source: detectedCatalog?.source ?? 'live',
                  models: detectedCatalog?.models ?? [],
                  default_model: detectedCatalog?.default_model ?? null,
                  error: detectedCatalog?.error ?? null,
                }}
                defaultModelDetecting={detectingModels}
                defaultModels={detectedCatalog?.models ?? []}
                hideCustomSlugs={(detectedCatalog?.models ?? []).map(
                  (item) => item.id
                )}
                disabled={busy}
                draft={mergeCodexConfigDraft(
                  parseCodexModel(model),
                  codexConfig
                )}
                showOfficialModels={false}
                customModelTests={customModelTests}
                onTestCustomModel={(index, slug) =>
                  void testCustomModel(index, slug)
                }
                onCustomModelSlugChange={(index) =>
                  setCustomModelTests((current) => {
                    if (!(index in current)) return current;
                    const next = { ...current };
                    delete next[index];
                    return next;
                  })
                }
                onCustomModelRemove={(index) =>
                  setCustomModelTests((current) => {
                    const next: Record<number, CustomModelTestState> = {};
                    for (const [key, value] of Object.entries(current)) {
                      const currentIndex = Number(key);
                      if (currentIndex < index) next[currentIndex] = value;
                      else if (currentIndex > index)
                        next[currentIndex - 1] = value;
                    }
                    return next;
                  })
                }
                onDefaultModelOpen={() => {
                  if (
                    detectingModels ||
                    detectedCatalog ||
                    !apiUrl.trim() ||
                    !apiKey.trim()
                  ) {
                    return;
                  }
                  void detectModels();
                }}
                onChange={(next) => setModel(serializeCodexModel(next))}
              />
            </div>
          </div>
        ) : (
          <label className="agent-model-provider-model">
            <span>{t('settings:agents.model')}</span>
            <input
              aria-label={t('settings:agents.providerModelAria')}
              autoComplete="off"
              disabled={busy}
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
        disabled={busy}
        onClick={() => void save()}
      >
        {id
          ? t('settings:agents.saveChanges')
          : t('settings:agents.providerCreate')}
      </Button>
    </div>
  );

  const toolbar = (
    <div className="agent-model-provider-toolbar">
      <Button size="sm" className="h-8" disabled={busy} onClick={openCreate}>
        <Plus aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
        {t('settings:agents.providerCreateButton')}
      </Button>
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
              onClick={() => void loadImport('native')}
            >
              {t('settings:agents.providerImportNative')}
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => void loadImport('cc_switch')}
            >
              {t('settings:agents.providerImportCcSwitch')}
            </button>
            {pluginImportSources.map((item) => {
              const metadata = contributionMetadata(item);
              const Icon = contributionIconComponent(metadata.icon, Upload);
              return (
                <button
                  key={`${item.pluginId}:${item.id}`}
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  title={
                    typeof metadata.description === 'string'
                      ? metadata.description
                      : undefined
                  }
                  onClick={() => void loadPluginImport(item)}
                >
                  <Icon aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                  {item.label}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );

  const list = (
    <div className="agent-model-provider-body">
      {importPreview ? (
        <ImportPreview
          preview={importPreview}
          selected={importSelected}
          saving={busy}
          onToggle={(sourceId, checked) => {
            setImportSelected((current) =>
              checked
                ? [...current, sourceId]
                : current.filter((id) => id !== sourceId)
            );
          }}
          onCancel={() => {
            setImportPreview(null);
            setImportSelected([]);
          }}
          onApply={() => void applyImport()}
        />
      ) : null}

      {loading ? (
        <p className="agent-model-provider-state" aria-live="polite">
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          {t('settings:agents.providerLoading')}
        </p>
      ) : providers.length === 0 ? (
        <div className="agent-model-provider-empty">
          <p>{t('settings:agents.providerNoneDetected')}</p>
          <Button
            size="sm"
            className="h-8"
            disabled={busy}
            onClick={openCreate}
          >
            <Plus aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
            {t('settings:agents.providerCreateButton')}
          </Button>
        </div>
      ) : (
        <ul className="agent-model-provider-list">
          {providers.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              busy={busy}
              canDelete={!provider.bound && providers.length > 1}
              probe={probes[provider.id]}
              onEnable={() => void bind(provider.id)}
              onEdit={() => openEdit(provider)}
              onTest={() => void testConnection(provider)}
              onCopy={() => void copyConfig(provider)}
              onDelete={() => void remove(provider)}
            />
          ))}
        </ul>
      )}
    </div>
  );

  const content = (
    <>
      {surface === 'form' ? form : list}
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
        <div className="agent-model-provider-heading">
          <h4 id={`${agentId}-model-provider-heading`}>
            {t('settings:agents.providerTitle')}
          </h4>
          {surface === 'list' ? toolbar : null}
        </div>
        {content}
      </section>
    );
  }

  return (
    <section className="agent-model-provider-manager is-embedded">
      {loaded ? (
        content
      ) : (
        <Button size="sm" variant="outline" onClick={() => void load()}>
          {t('settings:agents.providerTitle')}
        </Button>
      )}
    </section>
  );
}

function ProviderSecretField({
  agentId,
  value,
  disabled,
  onChange,
}: {
  agentId: AgentId;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const [revealed, setRevealed] = useState(false);
  const copyKey = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('agents.providerKeyCopied'));
    } catch {
      toast.error(t('agents.providerCopyFailed'));
    }
  };
  return (
    <label>
      <span>API Key</span>
      <div className="agent-model-provider-secret">
        <input
          aria-label="Provider API Key"
          autoComplete="new-password"
          disabled={disabled}
          name={`${agentId}_model_provider_api_key`}
          placeholder={t('settings:agents.providerKeyPlaceholder')}
          spellCheck={false}
          type={revealed ? 'text' : 'password'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          size="sm"
          type="button"
          variant="ghost"
          className="h-8 w-8 p-0"
          aria-label={
            revealed ? t('agents.providerHideKey') : t('agents.providerShowKey')
          }
          disabled={disabled || !value}
          onClick={() => setRevealed((current) => !current)}
        >
          {revealed ? (
            <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
          ) : (
            <Eye aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          size="sm"
          type="button"
          variant="ghost"
          className="h-8 w-8 p-0"
          aria-label={t('agents.providerCopyKey')}
          disabled={disabled || !value}
          onClick={() => void copyKey()}
        >
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </label>
  );
}

function ProviderCard({
  provider,
  busy,
  canDelete,
  probe,
  onEnable,
  onEdit,
  onTest,
  onCopy,
  onDelete,
}: {
  provider: AgentModelProviderView;
  busy: boolean;
  canDelete: boolean;
  probe: AgentModelProviderProbeView | 'loading' | undefined;
  onEnable: () => void;
  onEdit: () => void;
  onTest: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('settings');
  const latency =
    probe && probe !== 'loading' ? `${probe.latency_ms} ms` : null;
  return (
    <li data-bound={provider.bound}>
      <div>
        <strong>{provider.name}</strong>
        <p>{provider.api_url || t('agents.providerNativeBadge')}</p>
      </div>
      <div className="agent-model-provider-card-actions">
        {latency ? (
          <span
            className={cn(
              'agent-model-provider-latency',
              probe !== 'loading' && probe?.ok && 'is-ok'
            )}
          >
            {latency}
          </span>
        ) : null}
        <Button
          size="sm"
          variant={provider.bound ? 'outline' : 'default'}
          className={cn(
            'agent-model-provider-enable h-7',
            provider.bound && 'is-enabled'
          )}
          disabled={busy || provider.bound}
          onClick={onEnable}
        >
          {provider.bound ? (
            <Check aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
          ) : null}
          {provider.bound
            ? t('agents.providerEnabled')
            : t('agents.providerEnable')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          aria-label={t('agents.providerEditAria', { name: provider.name })}
          disabled={busy}
          onClick={onEdit}
        >
          <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          aria-label={t('agents.providerTestAria', { name: provider.name })}
          disabled={busy || probe === 'loading'}
          onClick={onTest}
        >
          {probe === 'loading' ? (
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Timer aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          aria-label={t('agents.providerCopyAria', { name: provider.name })}
          disabled={busy}
          onClick={onCopy}
        >
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0"
          aria-label={t('agents.providerDeleteAria', { name: provider.name })}
          disabled={busy || !canDelete}
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
        </Button>
      </div>
    </li>
  );
}

/** One provider a plugin found, ready to go through the normal save path. */
interface PluginImportDraft {
  name: string;
  api_url: string;
  api_key: string | null;
  model: string;
}

type ImportOrigin =
  | { kind: 'builtin'; source: AgentModelProviderImportSource }
  | { kind: 'plugin'; label: string; drafts: Map<string, PluginImportDraft> };

type ImportPreviewModel = Pick<
  AgentModelProviderImportPreviewView,
  'candidates' | 'error'
> & { origin: ImportOrigin };

/**
 * Reads whatever a plugin's import handler returned.
 *
 * The payload crosses a Worker boundary, so every field is checked rather than
 * cast. A candidate missing a name or URL is dropped instead of failing the
 * whole import — one malformed entry should not hide the rest.
 */
export function pluginImportCandidates(
  payload: unknown,
  /** Shown against a candidate the store cannot accept. Translated by the caller. */
  missingKeyReason: string
): {
  view: AgentModelProviderImportPreviewView['candidates'][number];
  draft: PluginImportDraft;
}[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as { providers?: unknown }).providers)
      ? (payload as { providers: unknown[] }).providers
      : [];
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  return rows.flatMap((row, index) => {
    if (!row || typeof row !== 'object') return [];
    const record = row as Record<string, unknown>;
    const name = text(record.name);
    const apiUrl = text(record.apiUrl) ?? text(record.api_url);
    if (!name || !apiUrl) return [];
    const apiKey = text(record.apiKey) ?? text(record.api_key);
    const model = text(record.model) ?? '';
    return [
      {
        view: {
          source_id:
            text(record.id) ?? text(record.sourceId) ?? `plugin-${index}`,
          name,
          api_url: apiUrl,
          model,
          credential_present: apiKey !== null,
          // The store requires a key, so a keyless candidate cannot be saved.
          skip_reason: apiKey ? null : missingKeyReason,
        },
        draft: { name, api_url: apiUrl, api_key: apiKey, model },
      },
    ];
  });
}

function ImportPreview({
  preview,
  selected,
  saving,
  onToggle,
  onCancel,
  onApply,
}: {
  // Plugin-contributed sources produce the same candidate list without going
  // through the built-in import command, so this only needs the parts it renders.
  preview: Pick<AgentModelProviderImportPreviewView, 'candidates' | 'error'>;
  selected: string[];
  saving: boolean;
  onToggle: (sourceId: string, checked: boolean) => void;
  onCancel: () => void;
  onApply: () => void;
}) {
  const { t } = useTranslation('settings');
  const selectable = preview.candidates.filter(
    (candidate) => !candidate.skip_reason
  );
  return (
    <div className="agent-model-provider-import-preview">
      {preview.candidates.length === 0 ? (
        <p>{preview.error ?? t('agents.providerImportEmpty')}</p>
      ) : (
        <ul>
          {preview.candidates.map((candidate) => (
            <ImportCandidateRow
              key={candidate.source_id}
              candidate={candidate}
              checked={selected.includes(candidate.source_id)}
              disabled={saving}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
      <div className="agent-model-provider-import-actions">
        <Button size="sm" variant="outline" className="h-8" onClick={onCancel}>
          {t('agents.providerImportCancel')}
        </Button>
        <Button
          size="sm"
          className="h-8"
          disabled={saving || selectable.length === 0 || selected.length === 0}
          onClick={onApply}
        >
          {t('agents.providerImportApply')}
        </Button>
      </div>
    </div>
  );
}

function ImportCandidateRow({
  candidate,
  checked,
  disabled,
  onToggle,
}: {
  candidate: AgentModelProviderImportCandidateView;
  checked: boolean;
  disabled: boolean;
  onToggle: (sourceId: string, checked: boolean) => void;
}) {
  const blocked = Boolean(candidate.skip_reason);
  return (
    <li>
      <label>
        <input
          type="checkbox"
          checked={checked && !blocked}
          disabled={disabled || blocked}
          onChange={(event) =>
            onToggle(candidate.source_id, event.target.checked)
          }
        />
        <span>
          <strong>{candidate.name}</strong>
          <small>{candidate.api_url}</small>
          {candidate.skip_reason ? <em>{candidate.skip_reason}</em> : null}
        </span>
      </label>
    </li>
  );
}

function parseCopiedModel(model: string): unknown {
  if (!model.trim()) return null;
  try {
    return JSON.parse(model) as unknown;
  } catch {
    return model;
  }
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
  selectedIds,
  onDetect,
  onMappingTargetChange,
  onToggleModel,
  onToggleAll,
}: {
  agentId: AgentId;
  catalog: AgentModelCatalogView | null;
  claudeMappingTarget: string;
  disabled: boolean;
  error: string | null;
  loading: boolean;
  selectedIds: string[];
  onDetect: () => void;
  onMappingTargetChange: (value: string) => void;
  onToggleModel: (id: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const models = catalog?.models ?? [];
  const selected = new Set(selectedIds);
  const allSelected =
    models.length > 0 && models.every((item) => selected.has(item.id));
  return (
    <div className="agent-model-provider-detection">
      <div className="provider-detected-models-heading">
        <span className="provider-detected-models-title">
          {t('agents.providerDetectedModels')}
        </span>
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
          <div className="provider-detected-models-heading-actions">
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={disabled || loading || allSelected}
              onClick={() => onToggleAll(true)}
            >
              {t('agents.providerDetectedSelectAll')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={disabled || loading || selected.size === 0}
              onClick={() => onToggleAll(false)}
            >
              {t('agents.providerDetectedClear')}
            </Button>
          </div>
        ) : null}
      </div>
      {models.length > 0 ? (
        <div
          className="provider-detected-models"
          role="group"
          aria-label={t('agents.providerDetectedModels')}
        >
          {models.map((detected) => (
            <label key={detected.id}>
              <input
                type="checkbox"
                checked={selected.has(detected.id)}
                disabled={disabled || loading}
                name={`detected_model_${detected.id}`}
                onChange={(event) =>
                  onToggleModel(detected.id, event.target.checked)
                }
              />
              <span>
                <strong>{detected.label}</strong>
                {/* The id only adds information when it differs from the name. */}
                {detected.label === detected.id ? null : (
                  <code title={detected.id}>{detected.id}</code>
                )}
              </span>
            </label>
          ))}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}

/** Menu value that switches the field over to free-text entry. */
const CUSTOM_MODEL_SENTINEL = '__custom__';

/**
 * A model id field that offers the models the user enabled above it.
 *
 * The detection panel is where models get chosen, so asking for the same name
 * again as free text made the two halves of the form look unrelated. When
 * there is nothing to offer the field stays a plain input, which keeps the
 * "the endpoint does not list the model I want" path intact.
 */
function ProviderModelField({
  label,
  ariaLabel,
  name,
  value,
  choices,
  disabled,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  name: string;
  value: string;
  choices: readonly string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const listed = value === '' || choices.includes(value);
  const [typing, setTyping] = useState(!listed);
  // A value saved before this model list existed has no option to sit on, so
  // show it as its own entry instead of an empty picker.
  const unlisted = value !== '' && !choices.includes(value);

  if (choices.length === 0) {
    return (
      <label>
        <span>{label}</span>
        <input
          aria-label={ariaLabel}
          autoComplete="off"
          disabled={disabled}
          name={name}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }

  if (typing) {
    return (
      <label>
        <span>{label}</span>
        {/* A span, not a div: a label's content model is phrasing content. */}
        <span className="provider-model-field-custom">
          <input
            aria-label={ariaLabel}
            autoComplete="off"
            disabled={disabled}
            name={name}
            spellCheck={false}
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            disabled={disabled}
            onClick={() => setTyping(false)}
          >
            {t('agents.providerModelUseList')}
          </Button>
        </span>
      </label>
    );
  }

  return (
    <label>
      <span>{label}</span>
      <AstryxSelect
        ariaLabel={ariaLabel}
        disabled={disabled}
        value={value}
        options={[
          ...choices.map((id) => ({ value: id, label: id })),
          ...(unlisted
            ? [{ value, label: `${value} (${t('agents.custom')})` }]
            : []),
          {
            value: CUSTOM_MODEL_SENTINEL,
            label: t('agents.providerModelCustomOption'),
          },
        ]}
        onChange={(next) => {
          if (next === CUSTOM_MODEL_SENTINEL) {
            setTyping(true);
            return;
          }
          onChange(next);
        }}
      />
    </label>
  );
}

function GrokProviderModelEditor({
  value,
  choices,
  disabled,
  onChange,
}: {
  value: string;
  choices: readonly string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const parsed = parseGrokModel(value);
  const patch = (next: GrokModelSpec) => {
    const payload: Record<string, unknown> = {
      ...parsed.raw,
      id: next.id,
      api_backend: next.api_backend,
      context_window: next.context_window ? Number(next.context_window) : null,
    };
    // Same as Pi: reorder only for a model the user had already enabled.
    const enabled = enabledModelIds(value);
    if (next.id !== '' && enabled.includes(next.id)) {
      payload.models = [next.id, ...enabled.filter((id) => id !== next.id)];
    }
    onChange(JSON.stringify(payload));
  };
  return (
    <fieldset className="agent-model-provider-claude">
      <legend>{t('agents.model')}</legend>
      <ProviderModelField
        ariaLabel={t('agents.providerModelAria')}
        choices={choices}
        disabled={disabled}
        label={t('agents.model')}
        name="grok_provider_model"
        value={parsed.id}
        onChange={(id) => patch({ ...parsed, id })}
      />
      <label>
        <span>{t('agents.grokApiBackend')}</span>
        <AstryxSelect
          ariaLabel={t('agents.grokApiBackend')}
          disabled={disabled}
          value={parsed.api_backend}
          options={[
            { value: 'responses', label: 'OpenAI Responses' },
            { value: 'chat_completions', label: 'OpenAI Chat Completions' },
            { value: 'messages', label: 'Anthropic Messages' },
          ]}
          onChange={(api_backend) => patch({ ...parsed, api_backend })}
        />
      </label>
      <label>
        <span>{t('agents.grokContextWindow')}</span>
        <input
          aria-label={t('agents.grokContextWindow')}
          autoComplete="off"
          disabled={disabled}
          inputMode="numeric"
          name="grok_provider_context"
          value={parsed.context_window}
          onChange={(event) =>
            patch({ ...parsed, context_window: event.target.value })
          }
        />
      </label>
    </fieldset>
  );
}

const PI_PROTOCOLS = [
  'openai-responses',
  'openai-completions',
  'anthropic-messages',
  'google-generative-ai',
] as const;

function PiProviderModelEditor({
  value,
  choices,
  disabled,
  onChange,
}: {
  value: string;
  choices: readonly string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const parsed = parsePiModel(value);
  const patch = (next: PiModelSpec) => {
    const payload: Record<string, unknown> = {
      ...parsed.raw,
      id: next.id,
      api: next.api,
    };
    // Picking one of the enabled models makes it the default, and the backend
    // reads the first entry, so it has to lead the list. A typed id is left
    // out of the list entirely: the list is what the detection panel manages,
    // and adding every keystroke to it would fill it with partial ids.
    const enabled = enabledModelIds(value);
    if (next.id !== '' && enabled.includes(next.id)) {
      payload.models = [next.id, ...enabled.filter((id) => id !== next.id)];
    }
    onChange(JSON.stringify(payload));
  };
  return (
    <fieldset className="agent-model-provider-claude">
      <legend>{t('agents.model')}</legend>
      <ProviderModelField
        ariaLabel={t('agents.providerModelAria')}
        choices={choices}
        disabled={disabled}
        label={t('agents.model')}
        name="pi_provider_model"
        value={parsed.id}
        onChange={(id) => patch({ ...parsed, id })}
      />
      <label>
        <span>{t('agents.customProviderProtocol')}</span>
        <AstryxSelect
          ariaLabel={t('agents.customProviderProtocol')}
          disabled={disabled}
          value={parsed.api}
          options={PI_PROTOCOLS.map((protocol) => ({
            value: protocol,
            label: protocol,
          }))}
          onChange={(api) => patch({ ...parsed, api })}
        />
      </label>
    </fieldset>
  );
}

interface PiModelSpec {
  id: string;
  api: string;
  /**
   * The parsed object as written, so a patch can add to it instead of
   * rebuilding it from the keys this editor happens to know. Rebuilding is
   * what used to drop the selected-models list on an unrelated edit.
   */
  raw: Record<string, unknown>;
}

function parsePiModel(value: string): PiModelSpec {
  try {
    const parsed = JSON.parse(value) as { id?: unknown; api?: unknown };
    if (parsed && typeof parsed === 'object') {
      return {
        id: typeof parsed.id === 'string' ? parsed.id : '',
        api:
          typeof parsed.api === 'string' &&
          PI_PROTOCOLS.includes(parsed.api as (typeof PI_PROTOCOLS)[number])
            ? parsed.api
            : 'openai-responses',
        raw: parsed as Record<string, unknown>,
      };
    }
  } catch {
    /* plain model id */
  }
  return { id: value, api: 'openai-responses', raw: {} };
}

interface GrokModelSpec {
  id: string;
  api_backend: string;
  context_window: string;
  raw: Record<string, unknown>;
}

function parseGrokModel(value: string): GrokModelSpec {
  try {
    const parsed = JSON.parse(value) as {
      id?: string;
      model?: string;
      api_backend?: string;
      context_window?: number | string | null;
    };
    if (parsed && typeof parsed === 'object') {
      return {
        id: String(parsed.id ?? parsed.model ?? ''),
        api_backend: parsed.api_backend || 'responses',
        context_window:
          parsed.context_window == null ? '' : String(parsed.context_window),
        raw: parsed as Record<string, unknown>,
      };
    }
  } catch {
    // Plain model id from an older preset.
  }
  return {
    id: value,
    api_backend: 'responses',
    context_window: '',
    raw: {},
  };
}

function ClaudeProviderModelEditor({
  value,
  choices,
  disabled,
  onChange,
}: {
  value: string;
  choices: readonly string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation('settings');
  const parsed = parseClaudeModel(value);
  const write = (key: string, nextValue: string) => {
    // Edit the parsed object rather than a copy of the keys we render: an
    // unrelated field must not drop what we do not know about.
    const next = { ...parsed.raw };
    if (nextValue) next[key] = nextValue;
    else delete next[key];
    onChange(Object.keys(next).length ? JSON.stringify(next) : '');
  };
  return (
    <fieldset className="agent-model-provider-claude">
      <legend>{t('agents.providerModelMapping')}</legend>
      {CLAUDE_MODEL_FIELDS.map(([key, labelKey, kind]) => {
        const label = t(`agents.${labelKey}`);
        const ariaLabel = t('agents.providerModelFieldAria', { label });
        if (kind === 'text') {
          return (
            <label key={key}>
              <span>{label}</span>
              <input
                aria-label={ariaLabel}
                autoComplete="off"
                disabled={disabled}
                name={`claude_provider_${key}`}
                spellCheck={false}
                value={parsed.values[key] ?? ''}
                onChange={(event) => write(key, event.target.value)}
              />
            </label>
          );
        }
        return (
          <ProviderModelField
            key={key}
            ariaLabel={ariaLabel}
            choices={choices}
            disabled={disabled}
            label={label}
            name={`claude_provider_${key}`}
            value={parsed.values[key] ?? ''}
            onChange={(next) => write(key, next)}
          />
        );
      })}
    </fieldset>
  );
}

interface ClaudeModelSpec {
  /** The env-var mapping keys this editor renders, values only. */
  values: Record<string, string>;
  /** Every key as written, so an edit cannot drop the ones we do not render. */
  raw: Record<string, unknown>;
}

function parseClaudeModel(value: string): ClaudeModelSpec {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { values: {}, raw: {} };
    return {
      values: Object.fromEntries(
        Object.entries(parsed).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      ),
      raw: parsed as Record<string, unknown>,
    };
  } catch {
    return value.trim()
      ? { values: { main: value.trim() }, raw: {} }
      : { values: {}, raw: {} };
  }
}

function reindexCustomModelTests(
  current: Record<number, CustomModelTestState>,
  removedIndex: number
): Record<number, CustomModelTestState> {
  const next: Record<number, CustomModelTestState> = {};
  for (const [key, value] of Object.entries(current)) {
    const currentIndex = Number(key);
    if (currentIndex < removedIndex) next[currentIndex] = value;
    else if (currentIndex > removedIndex) next[currentIndex - 1] = value;
  }
  return next;
}

function selectedModelIds(value: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    const next = id.trim();
    if (!next || seen.has(next)) return;
    seen.add(next);
    ids.push(next);
  };
  try {
    const parsed = JSON.parse(value) as {
      id?: unknown;
      default?: unknown;
      main?: unknown;
      models?: unknown;
    };
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.id === 'string') add(parsed.id);
      if (typeof parsed.default === 'string') add(parsed.default);
      if (typeof parsed.main === 'string') add(parsed.main);
      if (Array.isArray(parsed.models)) {
        for (const item of parsed.models) {
          if (typeof item === 'string') add(item);
          else if (
            item &&
            typeof item === 'object' &&
            typeof (item as { id?: unknown }).id === 'string'
          ) {
            add((item as { id: string }).id);
          }
        }
      }
      if (ids.length) return ids;
    }
  } catch {
    /* plain model id */
  }
  if (value.trim()) add(value);
  return ids;
}

/**
 * The models the picker offers: the ones the user enabled in the detection
 * panel, plus everything the last detection returned.
 *
 * Reading only the `models` list matters. The primary model lives in `id`
 * (or, for Claude, in the mapping keys), and feeding that back in would make
 * a typed model id promote itself into the picker mid-keystroke — the field
 * would turn into a dropdown while the user was still typing.
 */
function providerModelChoices(
  model: string,
  catalog: AgentModelCatalogView | null
): string[] {
  return [
    ...new Set([
      ...enabledModelIds(model),
      ...(catalog?.models ?? []).map((item) => item.id),
    ]),
  ];
}

/** The `models` list as written, ignoring the primary/default model keys. */
function enabledModelIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as { models?: unknown };
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray(parsed.models)
    ) {
      return [];
    }
    const ids: string[] = [];
    for (const item of parsed.models) {
      if (typeof item === 'string' && item.trim()) ids.push(item.trim());
      else if (
        item &&
        typeof item === 'object' &&
        typeof (item as { id?: unknown }).id === 'string'
      ) {
        const id = (item as { id: string }).id.trim();
        if (id) ids.push(id);
      }
    }
    return [...new Set(ids)];
  } catch {
    return [];
  }
}

function serializeSelectedModels(
  agentId: AgentId,
  current: string,
  ids: string[]
): string {
  if (agentId === 'grok') {
    const parsed = parseGrokModel(current);
    return JSON.stringify({
      ...parsed.raw,
      id: ids[0] ?? '',
      api_backend: parsed.api_backend,
      context_window: parsed.context_window
        ? Number(parsed.context_window)
        : null,
      models: ids,
    });
  }
  if (agentId === 'pi') {
    const parsed = parsePiModel(current);
    return JSON.stringify({
      ...parsed.raw,
      id: ids[0] ?? '',
      api: parsed.api,
      models: ids,
    });
  }
  if (ids.length <= 1) return ids[0] ?? '';
  return JSON.stringify({ default: ids[0], models: ids });
}

function selectedDetectedIds(
  agentId: AgentId,
  model: string,
  catalog: AgentModelCatalogView | null,
  codexConfig: CodexModelCatalogConfigView | null
): string[] {
  const detected = new Set((catalog?.models ?? []).map((item) => item.id));
  if (!detected.size) return [];
  if (agentId === 'codex') {
    const draft = mergeCodexConfigDraft(parseCodexModel(model), codexConfig);
    return [
      ...new Set([
        ...draft.customs.map((custom) => custom.slug),
        ...(draft.default_model ? [draft.default_model] : []),
      ]),
    ].filter((id) => detected.has(id));
  }
  if (agentId === 'claude_code') {
    return [...new Set(Object.values(parseClaudeModel(model).values))].filter(
      (id) => detected.has(id)
    );
  }
  return selectedModelIds(model).filter((id) => detected.has(id));
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

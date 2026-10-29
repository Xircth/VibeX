import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AgentId,
  AgentModelCatalogView,
  AgentModelProviderProbeView,
  AgentModelProvidersView,
  CodexModelCatalogConfigView,
} from 'shared/types';

import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';
import {
  contributionMetadata,
  usePluginHostContributions,
} from '@/hooks/usePluginHostContributions';
import { createPluginControlApi } from '@/lib/api/plugins';
import { useBackendTransport } from '@/lib/transport';

import type { CustomModelTestState } from '../CodexModelCatalogEditor';
import type { ProviderCatalogTemplateView } from '../providerCatalogTypes';
import { useProviderCatalogList } from '../useProviderCatalogList';
import {
  EMPTY_FORM_SNAPSHOT,
  type ImportPreviewModel,
  type ProviderFormSnapshot,
  type Surface,
} from './types';

export function useProviderFormState({
  agentId,
  onDirtyChange,
  active,
  embedded,
}: {
  agentId: AgentId;
  onDirtyChange?: (dirty: boolean) => void;
  active: boolean;
  embedded: boolean;
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
  const [initialForm, setInitialForm] =
    useState<ProviderFormSnapshot>(EMPTY_FORM_SNAPSHOT);
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
  const catalogEnabled = surface === 'form' && !id;
  const { catalog, catalogError, catalogGeneration, hasCatalogContributions } =
    useProviderCatalogList(agentId, catalogEnabled);
  const [endpointCandidates, setEndpointCandidates] = useState<string[]>([]);
  const [websiteUrl, setWebsiteUrl] = useState<string | null>(null);
  const [apiKeyUrl, setApiKeyUrl] = useState<string | null>(null);
  const formOpen = surface === 'form';
  const formDirty =
    formOpen &&
    (id !== initialForm.id ||
      name !== initialForm.name ||
      apiUrl !== initialForm.apiUrl ||
      apiKey !== initialForm.apiKey ||
      model !== initialForm.model);
  const loadGenerationRef = useRef(0);

  useEffect(() => {
    onDirtyChange?.(formDirty);
    return () => onDirtyChange?.(false);
  }, [formDirty, onDirtyChange]);

  useEffect(() => {
    loadGenerationRef.current += 1;
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

  useEffect(() => {
    if (!active) return;
    setLoaded(false);
  }, [active, agentId]);

  const load = useCallback(async () => {
    if (loaded || loading) return;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const providers = await agentManagementApi.modelProviders(agentId);
      if (generation !== loadGenerationRef.current) return;
      setView(providers);
      setLoaded(true);
      if (agentId === 'codex') {
        void Promise.all([
          agentManagementApi.codexModelCatalog(false).catch(() => null),
          agentManagementApi.codexModelCatalogConfig().catch(() => null),
        ]).then(([catalog, modelConfig]) => {
          if (generation !== loadGenerationRef.current) return;
          setCodexCatalog(catalog);
          setCodexConfig(modelConfig);
        });
      }
    } catch (cause) {
      if (generation !== loadGenerationRef.current) return;
      setError(errorMessage(cause, t('settings:agents.providerActionFailed')));
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
      }
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
    setInitialForm(EMPTY_FORM_SNAPSHOT);
    setDetectedCatalog(null);
    setDetectionError(null);
    setCustomModelTests({});
    setEndpointCandidates([]);
    setWebsiteUrl(null);
    setApiKeyUrl(null);
  };

  const applyCatalogTemplate = (template: ProviderCatalogTemplateView) => {
    setName(
      template.name.trim() || template.display_name?.trim() || template.id
    );
    setApiUrl(template.api_url?.trim() || '');
    setApiKey('');
    setModel(template.model ?? '');
    setDetectedCatalog(null);
    setDetectionError(null);
    setCustomModelTests({});
    setEndpointCandidates(template.endpoint_candidates ?? []);
    setWebsiteUrl(template.website_url ?? null);
    setApiKeyUrl(template.api_key_url ?? null);
  };

  return {
    view,
    setView,
    codexCatalog,
    setCodexCatalog,
    codexConfig,
    setCodexConfig,
    loaded,
    setLoaded,
    loading,
    setLoading,
    saving,
    setSaving,
    error,
    setError,
    surface,
    setSurface,
    id,
    setId,
    name,
    setName,
    apiUrl,
    setApiUrl,
    apiKey,
    setApiKey,
    model,
    setModel,
    setInitialForm,
    detectedCatalog,
    setDetectedCatalog,
    detectingModels,
    setDetectingModels,
    detectionError,
    setDetectionError,
    customModelTests,
    setCustomModelTests,
    claudeMappingTarget,
    setClaudeMappingTarget,
    importOpen,
    setImportOpen,
    pluginApi,
    pluginImportSources,
    importPreview,
    setImportPreview,
    importSelected,
    setImportSelected,
    probes,
    setProbes,
    catalog,
    catalogError,
    catalogGeneration,
    hasCatalogContributions,
    endpointCandidates,
    websiteUrl,
    apiKeyUrl,
    formDirty,
    load,
    resetForm,
    applyCatalogTemplate,
  };
}

export type ProviderFormState = ReturnType<typeof useProviderFormState>;

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentId, AgentModelProviderView } from 'shared/types';

import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { toast } from '@/components/ui/toast';
import {
  agentManagementApi,
  agentManagementErrorMessage as errorMessage,
} from '@/features/agent-management';
import { piReasoningIssue } from '@/lib/piThinking';

import type { CustomModelTestState } from '../CodexModelCatalogEditor';
import {
  customModelVerified,
  mergeCodexConfigDraft,
  parseClaudeModel,
  parseCodexModel,
  parsePiModel,
  reindexCustomModelTests,
  selectedModelIds,
  serializeCodexModel,
  serializeSelectedModels,
} from './providerModelParse';
import type { ProviderFormState } from './useProviderFormState';

export function useProviderFormActions(
  state: ProviderFormState,
  {
    agentId,
    onChanged,
  }: {
    agentId: AgentId;
    onChanged?: () => void | Promise<void>;
  }
) {
  const { t } = useTranslation(['settings', 'common']);
  const {
    setSaving,
    setError,
    setView,
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
    setDetectingModels,
    setDetectionError,
    customModelTests,
    setCustomModelTests,
    claudeMappingTarget,
    formDirty,
    resetForm,
    codexCatalog,
    codexConfig,
  } = state;
  const detectGenerationRef = useRef(0);
  useEffect(() => {
    detectGenerationRef.current += 1;
    setDetectingModels(false);
  }, [agentId, setDetectingModels]);

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
    setInitialForm({
      id: provider.id,
      name: provider.name,
      apiUrl: provider.api_url,
      apiKey: provider.api_key,
      model: provider.model,
    });
    setDetectedCatalog(null);
    setDetectionError(null);
    setCustomModelTests({});
    setSurface('form');
    if (
      provider.api_url.trim() &&
      (provider.api_key.trim() || provider.credential_present)
    ) {
      void detectModels(
        provider.api_url.trim(),
        provider.api_key.trim() || null,
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
    detectGenerationRef.current += 1;
    setDetectingModels(false);
    resetForm();
    setSurface('list');
  };

  const detectModels = async (
    nextUrl = apiUrl.trim(),
    nextKey = apiKey.trim() || null,
    nextId = id
  ) => {
    const generation = ++detectGenerationRef.current;
    setDetectingModels(true);
    setDetectionError(null);
    try {
      const catalog = await agentManagementApi.modelProviderCatalog(
        agentId,
        nextId,
        nextUrl,
        nextKey
      );
      if (generation !== detectGenerationRef.current) return;
      setDetectedCatalog(catalog);
      setDetectionError(catalog.error);
    } catch (cause) {
      if (generation !== detectGenerationRef.current) return;
      setDetectedCatalog(null);
      setDetectionError(
        errorMessage(cause, t('settings:agents.providerModelDetectionFailed'))
      );
    } finally {
      if (generation === detectGenerationRef.current) {
        setDetectingModels(false);
      }
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
    if (!apiUrl.trim() || (!apiKey.trim() && !id)) {
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
    if (agentId === 'pi') {
      const parsed = parsePiModel(model);
      const issue = piReasoningIssue(parsed.reasoning, parsed.thinkingLevel);
      if (issue === 'empty-levels') {
        toast.warning(t('settings:agents.piThinkingLevelsEmpty'));
        return;
      }
      if (issue === 'default-unlisted') {
        toast.warning(t('settings:agents.piDefaultLevelUnlisted'));
        return;
      }
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

  return {
    openCreate,
    openEdit,
    closeForm,
    detectModels,
    toggleDetectedModel,
    toggleAllDetected,
    testCustomModel,
    save,
  };
}

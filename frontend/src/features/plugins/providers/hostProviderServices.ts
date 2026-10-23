import { Registry, serviceContainer } from '@vibex/plugin-sdk';
import { attemptsApi, configApi, projectsApi } from '@/lib/api';
import { createPluginControlApi } from '@/lib/api/plugins';
import {
  backendCall,
  configuredBackendTransport,
} from '@/lib/backendTransport';
import type {
  ProviderCatalogListView,
  ProviderCatalogSourceView,
  ProviderCatalogTemplateView,
} from '@/pages/settings/providerCatalogTypes';
import type { AgentId, EditorType, PlanUsageResult } from 'shared/types';

export interface RuntimeModelCatalogSource {
  id: string;
  pluginId: string;
  pluginLabel: string;
  label: string;
  agents: string[];
  description?: string | null;
  templates: Omit<
    ProviderCatalogTemplateView,
    'plugin_id' | 'plugin_label' | 'contribution_id'
  >[];
}

export interface ModelCatalogProviderService {
  listCatalog(
    agentId: string,
    fallbackFetcher?: (agentId: string) => Promise<ProviderCatalogListView>
  ): Promise<ProviderCatalogListView>;
  registerCatalogSource(source: RuntimeModelCatalogSource): () => void;
  listCatalogSources(agentId?: string): readonly RuntimeModelCatalogSource[];
  hasRuntimeSources(agentId?: string): boolean;
}

export interface UsageProberRegistration {
  id: string;
  pluginId?: string;
  label: string;
  agents?: string[];
  probe(input: {
    agentId: AgentId | string;
    current?: PlanUsageResult | null;
  }): Promise<PlanUsageResult | null | undefined>;
}

export interface UsageProviderService {
  probeAgentUsage(
    agentId: AgentId | string,
    fallbackFetcher?: (agentId: AgentId) => Promise<PlanUsageResult>
  ): Promise<PlanUsageResult>;
  registerUsageProber(prober: UsageProberRegistration): () => void;
  listUsageProbers(agentId?: string): readonly UsageProberRegistration[];
}

export interface CustomEditorOpenerRegistration {
  id: string;
  label: string;
  hint: string;
  pluginId?: string;
  isAvailable?: () => Promise<boolean> | boolean;
  openAttempt?: (input: {
    attemptId: string;
    editorType?: EditorType | string | null;
    filePath?: string | null;
  }) => Promise<{ url?: string } | void>;
  openProject?: (input: {
    projectId: string;
    editorType?: EditorType | string | null;
    filePath?: string | null;
  }) => Promise<{ url?: string } | void>;
}

export interface EditorOpenerProviderService {
  openAttemptInEditor(
    attemptId: string,
    options?: {
      editorType?: EditorType | string | null;
      filePath?: string | null;
    }
  ): Promise<{ url?: string }>;
  openProjectInEditor(
    projectId: string,
    options?: {
      editorType?: EditorType | string | null;
      filePath?: string | null;
    }
  ): Promise<{ url?: string }>;
  checkAvailability(editorType: EditorType | string): Promise<boolean>;
  registerEditorOpener(opener: CustomEditorOpenerRegistration): () => void;
  listEditorOpeners(): readonly CustomEditorOpenerRegistration[];
}

export const runtimeModelCatalogRegistry =
  new Registry<RuntimeModelCatalogSource>();
export const runtimeUsageProberRegistry =
  new Registry<UsageProberRegistration>();
export const runtimeEditorOpenerRegistry =
  new Registry<CustomEditorOpenerRegistration>();

function mergeCatalogWithRuntimeSources(
  agentId: string,
  baseView: ProviderCatalogListView
): ProviderCatalogListView {
  const runtimeSources = runtimeModelCatalogRegistry
    .getAll()
    .filter(
      (src) => src.agents.length === 0 || src.agents.includes(agentId)
    );
  if (runtimeSources.length === 0) {
    return baseView;
  }

  const existingTemplateKeys = new Set(
    baseView.templates.map(
      (tpl) => `${tpl.plugin_id}:${tpl.contribution_id}:${tpl.id}`
    )
  );
  const mergedTemplates = [...baseView.templates];
  const mergedSources: ProviderCatalogSourceView[] = [...baseView.sources];

  for (const src of runtimeSources) {
    let addedCount = 0;
    for (const tpl of src.templates) {
      if (tpl.agent_id && tpl.agent_id !== agentId) continue;
      const key = `${src.pluginId}:${src.id}:${tpl.id}`;
      if (existingTemplateKeys.has(key)) continue;
      existingTemplateKeys.add(key);
      mergedTemplates.push({
        ...tpl,
        plugin_id: src.pluginId,
        plugin_label: src.pluginLabel,
        contribution_id: src.id,
        agent_id: tpl.agent_id || agentId,
      });
      addedCount += 1;
    }
    if (
      !mergedSources.some(
        (existing) =>
          existing.plugin_id === src.pluginId &&
          existing.contribution_id === src.id
      )
    ) {
      mergedSources.push({
        plugin_id: src.pluginId,
        contribution_id: src.id,
        label: src.label,
        template_count: addedCount,
      });
    }
  }

  return {
    agent_id: baseView.agent_id || agentId,
    generation: baseView.generation,
    templates: mergedTemplates,
    sources: mergedSources,
  };
}

export const defaultModelCatalogProviderService: ModelCatalogProviderService = {
  async listCatalog(agentId, fallbackFetcher) {
    const fetcher =
      fallbackFetcher ??
      (async (id: string): Promise<ProviderCatalogListView> => {
        try {
          const api = createPluginControlApi(configuredBackendTransport);
          return (await api.providerCatalogList(id)) as ProviderCatalogListView;
        } catch {
          return {
            agent_id: id,
            generation: 0,
            templates: [],
            sources: [],
          };
        }
      });
    const baseView: ProviderCatalogListView = await fetcher(agentId);
    const merged = mergeCatalogWithRuntimeSources(agentId, {
      agent_id:
        typeof baseView?.agent_id === 'string' ? baseView.agent_id : agentId,
      generation:
        typeof baseView?.generation === 'number' ? baseView.generation : 0,
      templates: Array.isArray(baseView?.templates) ? baseView.templates : [],
      sources: Array.isArray(baseView?.sources) ? baseView.sources : [],
    });
    return serviceContainer.runWaterfall(
      'provider.model.catalog:resolve',
      merged,
      async (val) => val
    );
  },

  registerCatalogSource(source) {
    return runtimeModelCatalogRegistry.register(
      `${source.pluginId}:${source.id}`,
      source
    );
  },

  listCatalogSources(agentId) {
    const all = runtimeModelCatalogRegistry.getAll();
    if (!agentId) return all;
    return all.filter(
      (src) => src.agents.length === 0 || src.agents.includes(agentId)
    );
  },

  hasRuntimeSources(agentId) {
    return this.listCatalogSources(agentId).length > 0;
  },
};

export const defaultUsageProviderService: UsageProviderService = {
  async probeAgentUsage(agentId, fallbackFetcher) {
    const probers = this.listUsageProbers(String(agentId));
    let current: PlanUsageResult | null = null;
    const fetcher =
      fallbackFetcher ??
      ((id: AgentId) =>
        backendCall<PlanUsageResult>('agent_plan_usage', { agentId: id }));

    try {
      current = await fetcher(agentId as AgentId);
    } catch (err) {
      if (probers.length === 0) {
        throw err;
      }
    }

    for (const prober of probers) {
      try {
        const next = await prober.probe({ agentId, current });
        if (next) {
          current = next;
        }
      } catch (err) {
        console.warn(`[UsageProviderService] Prober "${prober.id}" failed:`, err);
      }
    }

    const baseResult: PlanUsageResult =
      current ??
      ({
        status: 'unavailable',
        reason: 'No usage prober returned data',
      } as unknown as PlanUsageResult);

    return serviceContainer.runWaterfall(
      'provider.usage:resolve',
      baseResult,
      async (val) => val
    );
  },

  registerUsageProber(prober) {
    return runtimeUsageProberRegistry.register(prober.id, prober);
  },

  listUsageProbers(agentId) {
    const all = runtimeUsageProberRegistry.getAll();
    if (!agentId) return all;
    return all.filter(
      (p) => !p.agents || p.agents.length === 0 || p.agents.includes(agentId)
    );
  },
};

export const defaultEditorOpenerProviderService: EditorOpenerProviderService = {
  async openAttemptInEditor(attemptId, options) {
    const editorType = options?.editorType ?? null;
    const filePath = options?.filePath ?? null;

    if (editorType) {
      const custom = runtimeEditorOpenerRegistry.get(String(editorType));
      if (custom?.openAttempt) {
        const res = await custom.openAttempt({
          attemptId,
          editorType,
          filePath,
        });
        return res ?? {};
      }
    }

    const initialAttemptPayload: {
      attemptId: string;
      editorType: EditorType | string | null;
      filePath: string | null;
      handled?: boolean;
      url?: string;
    } = {
      attemptId,
      editorType,
      filePath,
    };
    const intercepted = await serviceContainer.runWaterfall(
      'provider.editor.opener:openAttempt',
      initialAttemptPayload,
      async (val) => val
    );
    if (intercepted?.handled) {
      return { url: intercepted.url };
    }

    const response = await attemptsApi.openEditor(attemptId, {
      editor_type: (editorType as EditorType | null) ?? null,
      file_path: filePath,
    });
    return { url: response.url ?? undefined };
  },

  async openProjectInEditor(projectId, options) {
    const editorType = options?.editorType ?? null;
    const filePath = options?.filePath ?? null;

    if (editorType) {
      const custom = runtimeEditorOpenerRegistry.get(String(editorType));
      if (custom?.openProject) {
        const res = await custom.openProject({
          projectId,
          editorType,
          filePath,
        });
        return res ?? {};
      }
    }

    const initialProjectPayload: {
      projectId: string;
      editorType: EditorType | string | null;
      filePath: string | null;
      handled?: boolean;
      url?: string;
    } = {
      projectId,
      editorType,
      filePath,
    };
    const intercepted = await serviceContainer.runWaterfall(
      'provider.editor.opener:openProject',
      initialProjectPayload,
      async (val) => val
    );
    if (intercepted?.handled) {
      return { url: intercepted.url };
    }

    const response = await projectsApi.openEditor(projectId, {
      editor_type: (editorType as EditorType | null) ?? null,
      file_path: filePath,
    });
    return { url: response.url ?? undefined };
  },

  async checkAvailability(editorType) {
    const custom = runtimeEditorOpenerRegistry.get(String(editorType));
    if (custom?.isAvailable) {
      return Boolean(await custom.isAvailable());
    }
    const result = await configApi.checkEditorAvailability(
      editorType as EditorType
    );
    return Boolean(result.available);
  },

  registerEditorOpener(opener) {
    return runtimeEditorOpenerRegistry.register(opener.id, opener);
  },

  listEditorOpeners() {
    return runtimeEditorOpenerRegistry.getAll();
  },
};

let builtinsRegistered = false;
let disposeBuiltins: Array<() => void> = [];

export function ensureHostProviderServicesRegistered(): void {
  if (builtinsRegistered) {
    if (!serviceContainer.has('vibex.model-catalog')) {
      serviceContainer.provide(
        'vibex.model-catalog',
        defaultModelCatalogProviderService
      );
    }
    if (!serviceContainer.has('provider.model.catalog')) {
      serviceContainer.provide(
        'provider.model.catalog',
        defaultModelCatalogProviderService
      );
    }
    if (!serviceContainer.has('vibex.usage')) {
      serviceContainer.provide('vibex.usage', defaultUsageProviderService);
    }
    if (!serviceContainer.has('provider.usage')) {
      serviceContainer.provide('provider.usage', defaultUsageProviderService);
    }
    if (!serviceContainer.has('vibex.editor')) {
      serviceContainer.provide(
        'vibex.editor',
        defaultEditorOpenerProviderService
      );
    }
    if (!serviceContainer.has('provider.editor.opener')) {
      serviceContainer.provide(
        'provider.editor.opener',
        defaultEditorOpenerProviderService
      );
    }
    return;
  }
  builtinsRegistered = true;
  disposeBuiltins = [
    serviceContainer.provide(
      'vibex.model-catalog',
      defaultModelCatalogProviderService
    ),
    serviceContainer.provide(
      'provider.model.catalog',
      defaultModelCatalogProviderService
    ),
    serviceContainer.provide('vibex.usage', defaultUsageProviderService),
    serviceContainer.provide('provider.usage', defaultUsageProviderService),
    serviceContainer.provide(
      'vibex.editor',
      defaultEditorOpenerProviderService
    ),
    serviceContainer.provide(
      'provider.editor.opener',
      defaultEditorOpenerProviderService
    ),
  ];
}

export function resetHostProviderServicesForTest(): void {
  for (const dispose of disposeBuiltins) {
    dispose();
  }
  disposeBuiltins = [];
  builtinsRegistered = false;
  for (const id of runtimeModelCatalogRegistry.getIds()) {
    runtimeModelCatalogRegistry.unregister(id);
  }
  for (const id of runtimeUsageProberRegistry.getIds()) {
    runtimeUsageProberRegistry.unregister(id);
  }
  for (const id of runtimeEditorOpenerRegistry.getIds()) {
    runtimeEditorOpenerRegistry.unregister(id);
  }
  ensureHostProviderServicesRegistered();
}

export function getModelCatalogService(): ModelCatalogProviderService {
  ensureHostProviderServicesRegistered();
  return (
    serviceContainer.get<ModelCatalogProviderService>('vibex.model-catalog') ??
    serviceContainer.get<ModelCatalogProviderService>(
      'provider.model.catalog'
    ) ??
    defaultModelCatalogProviderService
  );
}

export function getUsageProviderService(): UsageProviderService {
  ensureHostProviderServicesRegistered();
  return (
    serviceContainer.get<UsageProviderService>('vibex.usage') ??
    serviceContainer.get<UsageProviderService>('provider.usage') ??
    defaultUsageProviderService
  );
}

export function getEditorOpenerService(): EditorOpenerProviderService {
  ensureHostProviderServicesRegistered();
  return (
    serviceContainer.get<EditorOpenerProviderService>('vibex.editor') ??
    serviceContainer.get<EditorOpenerProviderService>(
      'provider.editor.opener'
    ) ??
    defaultEditorOpenerProviderService
  );
}

// Register default host provider services immediately upon module import.
ensureHostProviderServicesRegistered();

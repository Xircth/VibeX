const DEFAULT_PROVIDERS = [
  {
    id: 'anthropic-official',
    label: 'Anthropic Official',
    category: 'official',
    baseUrl: 'https://api.anthropic.com',
  },
  {
    id: 'openai-official',
    label: 'OpenAI Official',
    category: 'official',
    baseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'deepseek-official',
    label: 'DeepSeek Official',
    category: 'official',
    baseUrl: 'https://api.deepseek.com',
  },
];

const CURATED_TEMPLATES = [
  {
    id: 'openrouter',
    agent_id: 'opencode',
    name: 'OpenRouter',
    category: 'aggregator',
    surface: 'opencode',
    provider_id: 'openrouter',
    npm: '@ai-sdk/openai-compatible',
    api: 'openai-compatible',
    base_url: 'https://openrouter.ai/api/v1',
    models: [
      {
        id: 'anthropic/claude-sonnet-4',
        name: 'Claude Sonnet 4',
      },
    ],
  },
  {
    id: 'siliconflow',
    agent_id: 'opencode',
    name: 'SiliconFlow',
    category: 'partner',
    surface: 'opencode',
    provider_id: 'siliconflow',
    npm: '@ai-sdk/openai-compatible',
    api: 'openai-compatible',
    base_url: 'https://api.siliconflow.cn/v1',
    models: [
      {
        id: 'Qwen/Qwen2.5-72B-Instruct',
        name: 'Qwen 2.5 72B Instruct',
      },
    ],
  },
];

export default {
  apiVersion: '2.0',
  id: 'vibex.provider-switch',
  activate(ctx) {
    for (const provider of DEFAULT_PROVIDERS) {
      ctx.registerProvider(provider);
    }

    ctx.provideService('vibex.provider-catalog', {
      listProviders: () => DEFAULT_PROVIDERS,
      listTemplates: (agentId) =>
        agentId
          ? CURATED_TEMPLATES.filter((t) => t.agent_id === agentId)
          : CURATED_TEMPLATES,
    });

    const hostCatalog = ctx.services.get('vibex.model-catalog');
    if (
      hostCatalog &&
      typeof hostCatalog.registerCatalogSource === 'function'
    ) {
      const disposeSource = hostCatalog.registerCatalogSource({
        id: 'provider-catalog',
        pluginId: 'vibex.provider-switch',
        pluginLabel: 'ProviderSwitch',
        label: 'Official Provider Catalog',
        agents: ['opencode', 'claude-code', 'codex'],
        description: 'Curated model provider templates grouped by Agent runtime.',
        templates: CURATED_TEMPLATES,
      });
      ctx.effect(() => disposeSource);
    }
  },
};

/**
 * Well-known OpenAI-compatible environment variable pairs.
 *
 * Each entry names the variables a vendor's own CLI documents, so a user who
 * already exported them for a terminal tool does not have to retype the same
 * endpoint into VibeX.
 */
export const KNOWN_PROVIDERS = [
  {
    id: 'openai',
    name: 'OpenAI',
    urlVars: ['OPENAI_BASE_URL', 'OPENAI_API_BASE'],
    keyVars: ['OPENAI_API_KEY'],
    modelVars: ['OPENAI_MODEL'],
    defaultUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    urlVars: ['ANTHROPIC_BASE_URL'],
    keyVars: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
    modelVars: ['ANTHROPIC_MODEL'],
    defaultUrl: 'https://api.anthropic.com',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    urlVars: ['DEEPSEEK_BASE_URL'],
    keyVars: ['DEEPSEEK_API_KEY'],
    modelVars: ['DEEPSEEK_MODEL'],
    defaultUrl: 'https://api.deepseek.com',
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    urlVars: ['MOONSHOT_BASE_URL'],
    keyVars: ['MOONSHOT_API_KEY'],
    modelVars: ['MOONSHOT_MODEL'],
    defaultUrl: 'https://api.moonshot.cn/v1',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    urlVars: ['OPENROUTER_BASE_URL'],
    keyVars: ['OPENROUTER_API_KEY'],
    modelVars: ['OPENROUTER_MODEL'],
    defaultUrl: 'https://openrouter.ai/api/v1',
  },
];

function firstSet(environment, names) {
  for (const name of names) {
    const value = environment[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Turns an environment into import candidates.
 *
 * A provider is only offered when something in the environment actually names
 * it — a key, or an explicitly set base URL. The built-in default URL fills in
 * the endpoint for a vendor whose key is set but whose URL is not, which is the
 * common case; it never invents a provider on its own.
 *
 * A provider found by URL alone is still reported, with a null key. The Host
 * lists it and blocks selection, which tells the user their half-configured
 * environment was seen rather than silently skipped.
 */
export function discoverProviders(environment) {
  return KNOWN_PROVIDERS.flatMap((provider) => {
    const apiKey = firstSet(environment, provider.keyVars);
    const explicitUrl = firstSet(environment, provider.urlVars);
    if (!apiKey && !explicitUrl) return [];
    return [
      {
        id: provider.id,
        name: provider.name,
        apiUrl: explicitUrl ?? provider.defaultUrl,
        apiKey,
        model: firstSet(environment, provider.modelVars) ?? '',
      },
    ];
  });
}

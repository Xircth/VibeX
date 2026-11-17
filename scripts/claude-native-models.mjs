import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isOfficialAnthropicSession, readString } from './claude-native-events.mjs';

const CLAUDE_ALIAS_IDS = new Set(['default', 'sonnet', 'opus', 'haiku', 'fable']);
const FAMILY_NAMES = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
};

const ALIAS_DEFAULT_LABELS = {
  default: 'Default',
  sonnet: 'Sonnet (Latest Alias)',
  opus: 'Opus (Latest Alias)',
  haiku: 'Haiku (Latest Alias)',
  fable: 'Fable (Latest Alias)',
};

export function resolveClaudeConfigDir(env = process.env) {
  const explicit = readString(env?.CLAUDE_CONFIG_DIR);
  if (explicit) return explicit;
  const home = readString(env?.USERPROFILE ?? env?.HOME);
  return home ? path.join(home, '.claude') : null;
}

export async function readClaudeSettingsEnv(env = process.env) {
  const configDir = resolveClaudeConfigDir(env);
  if (!configDir) return {};
  try {
    const raw = await fs.readFile(path.join(configDir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const settingsEnv = parsed.env;
    if (!settingsEnv || typeof settingsEnv !== 'object' || Array.isArray(settingsEnv)) return {};
    const out = {};
    for (const [key, val] of Object.entries(settingsEnv)) {
      const cleaned = readString(val);
      if (cleaned) out[key] = cleaned;
    }
    return out;
  } catch {
    return {};
  }
}

export function formatClaudeModelDisplayName(modelId) {
  const raw = readString(modelId);
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (ALIAS_DEFAULT_LABELS[lower]) {
    return ALIAS_DEFAULT_LABELS[lower];
  }

  // Strip optional Bedrock/provider prefix like `anthropic.` or `us.anthropic.`
  let normalized = raw;
  const slashIdx = normalized.lastIndexOf('/');
  if (slashIdx >= 0 && slashIdx < normalized.length - 1) {
    normalized = normalized.slice(slashIdx + 1);
  }
  normalized = normalized.replace(/^(?:(?:us|eu|apac)\.)?anthropic\./i, '');

  // Match e.g. `claude-opus-5-5`, `claude-fable-5`, `claude-sonnet-4-5-20250929`, `claude-3-7-sonnet-20250219`
  const modernMatch = normalized.match(
    /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?(?:-(\d{8}))?(?:-(.+))?$/i
  );
  if (modernMatch) {
    const [, familyRaw, major, minor, dateTag, extra] = modernMatch;
    const family = FAMILY_NAMES[familyRaw.toLowerCase()] ?? familyRaw;
    const version = minor ? `${major}.${minor}` : major;
    const parts = [`Claude ${family} ${version}`];
    if (extra) parts.push(extra);
    if (dateTag) parts.push(`(${dateTag})`);
    return parts.join(' ');
  }

  const legacyMatch = normalized.match(
    /^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku|fable)(?:-(\d{8}))?(?:-(.+))?$/i
  );
  if (legacyMatch) {
    const [, major, minor, familyRaw, dateTag, extra] = legacyMatch;
    const family = FAMILY_NAMES[familyRaw.toLowerCase()] ?? familyRaw;
    const version = minor ? `${major}.${minor}` : major;
    const parts = [`Claude ${version} ${family}`];
    if (extra) parts.push(extra);
    if (dateTag) parts.push(`(${dateTag})`);
    return parts.join(' ');
  }

  return raw;
}

function buildGatewayModelsUrl(baseUrl) {
  const raw = readString(baseUrl);
  if (!raw) return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null;
  }
  const trimmedPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = trimmedPath.endsWith('/v1')
    ? `${trimmedPath}/models`
    : `${trimmedPath}/v1/models`;
  return parsed.toString();
}

export async function fetchGatewayModels({
  baseUrl,
  authToken,
  apiKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = 1_500,
} = {}) {
  if (typeof fetchImpl !== 'function') return [];
  const url = buildGatewayModelsUrl(baseUrl);
  if (!url) return [];
  const token = readString(authToken);
  const key = readString(apiKey);
  if (!token && !key) return [];

  const headers = {
    Accept: 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['x-api-key'] = key;

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) return [];
    const body = await response.json();
    const rawItems = Array.isArray(body)
      ? body
      : Array.isArray(body?.data)
        ? body.data
        : Array.isArray(body?.models)
          ? body.models
          : [];
    const out = [];
    const seen = new Set();
    for (const item of rawItems) {
      if (typeof item === 'string') {
        const id = readString(item);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push({
          value: id,
          displayName: formatClaudeModelDisplayName(id),
        });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const id = readString(item.id ?? item.model ?? item.slug ?? item.value);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const rawName = readString(item.display_name ?? item.displayName ?? item.name);
      const displayName =
        rawName && rawName.toLowerCase() !== id.toLowerCase()
          ? rawName
          : formatClaudeModelDisplayName(id);
      const description = readString(item.description);
      out.push({
        value: id,
        displayName,
        ...(description ? { description } : {}),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function createNeverEndingPrompt(signal) {
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (signal?.aborted) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            const onAbort = () => resolve({ value: undefined, done: true });
            signal?.addEventListener('abort', onAbort, { once: true });
          });
        },
        return() {
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

export async function probeSdkSupportedModels({
  sdk,
  env = {},
  workingDir,
  applyExecutableToOptions,
  timeoutMs = 3_000,
} = {}) {
  if (!sdk || env?.DIMO_CLAUDE_SKIP_MODEL_PROBE === '1') return [];
  if (typeof sdk.supportedModels === 'function') {
    try {
      const result = await sdk.supportedModels();
      return Array.isArray(result) ? result : [];
    } catch {
      return [];
    }
  }

  const canProbeViaQuery =
    !sdk.isCliFallback &&
    typeof sdk.query === 'function' &&
    (typeof sdk.startup === 'function' ||
      typeof sdk.resolveSettings === 'function' ||
      sdk.__supportsQueryModelProbe === true);
  if (!canProbeViaQuery) return [];

  const abortController = new AbortController();
  const options = {
    cwd: workingDir || process.cwd(),
    env,
    abortController,
    settingSources: ['user', 'project', 'local'],
  };
  const explicitExe = readString(env?.CLAUDE_CODE_EXECUTABLE ?? env?.DIMO_CLAUDE_PATH);
  if (explicitExe && typeof applyExecutableToOptions === 'function') {
    applyExecutableToOptions(options, explicitExe, env, { isCliFallback: false });
  }

  let queryHandle = null;
  let timer = null;
  try {
    queryHandle = sdk.query({
      prompt: createNeverEndingPrompt(abortController.signal),
      options,
    });
    if (typeof queryHandle?.supportedModels !== 'function') {
      return [];
    }
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('supportedModels probe timed out')), timeoutMs);
    });
    const list = await Promise.race([queryHandle.supportedModels(), timeoutPromise]);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  } finally {
    if (timer) clearTimeout(timer);
    abortController.abort();
    try {
      queryHandle?.close?.();
    } catch {
      // Ignore cleanup failures after probe completes or aborts.
    }
  }
}

export function collectConfiguredClaudeModels(env = {}, configuredModel) {
  const candidates = [
    { id: readString(configuredModel), name: null, description: null },
    { id: readString(env.ANTHROPIC_MODEL), name: null, description: null },
    { id: readString(env.ANTHROPIC_REASONING_MODEL), name: null, description: null },
    {
      id: readString(env.ANTHROPIC_CUSTOM_MODEL_OPTION),
      name: readString(env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME),
      description: readString(env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION),
    },
    { id: readString(env.ANTHROPIC_DEFAULT_OPUS_MODEL), name: null, description: null },
    { id: readString(env.ANTHROPIC_DEFAULT_SONNET_MODEL), name: null, description: null },
    { id: readString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL), name: null, description: null },
    { id: readString(env.ANTHROPIC_DEFAULT_FABLE_MODEL), name: null, description: null },
    { id: readString(env.CLAUDE_CODE_SUBAGENT_MODEL), name: null, description: null },
  ];

  const out = [];
  const seen = new Set();
  for (const item of candidates) {
    if (!item.id || CLAUDE_ALIAS_IDS.has(item.id.toLowerCase()) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({
      value: item.id,
      displayName: item.name ?? formatClaudeModelDisplayName(item.id),
      ...(item.description ? { description: item.description } : {}),
    });
  }
  return out;
}

function normalizeModelEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = readString(raw.value ?? raw.id ?? raw.model);
  if (!id) return null;
  const isAlias = CLAUDE_ALIAS_IDS.has(id.toLowerCase());
  const rawName = readString(raw.displayName ?? raw.display_name ?? raw.label ?? raw.name);
  const displayName =
    rawName && (isAlias || rawName.toLowerCase() !== id.toLowerCase())
      ? rawName
      : formatClaudeModelDisplayName(id);
  const description = readString(raw.description);
  return {
    value: id,
    displayName,
    ...(description ? { description } : {}),
  };
}

export async function discoverClaudeModels({
  sdk,
  env = {},
  workingDir,
  configuredModel,
  auth = {},
  configOverrides = {},
  fetchImpl = globalThis.fetch,
  applyExecutableToOptions,
} = {}) {
  const settingsEnv = await readClaudeSettingsEnv(env);
  const effectiveEnv = { ...settingsEnv, ...env };
  const baseUrl =
    readString(auth?.baseUrl) ??
    readString(configOverrides?.anthropicBaseUrl) ??
    readString(configOverrides?.baseUrl) ??
    readString(effectiveEnv.ANTHROPIC_BASE_URL);
  const authToken = readString(effectiveEnv.ANTHROPIC_AUTH_TOKEN);
  const apiKey = readString(auth?.apiKey) ?? readString(effectiveEnv.ANTHROPIC_API_KEY);
  const isOfficial = isOfficialAnthropicSession({
    env: effectiveEnv,
    auth,
    configOverrides,
  });

  const [gatewayRes, sdkRes] = await Promise.allSettled([
    !isOfficial && baseUrl
      ? fetchGatewayModels({ baseUrl, authToken, apiKey, fetchImpl })
      : Promise.resolve([]),
    probeSdkSupportedModels({
      sdk,
      env: effectiveEnv,
      workingDir,
      applyExecutableToOptions,
    }),
  ]);

  const gatewayItems = gatewayRes.status === 'fulfilled' ? gatewayRes.value : [];
  const sdkItems = sdkRes.status === 'fulfilled' ? sdkRes.value : [];
  const configuredItems = collectConfiguredClaudeModels(effectiveEnv, configuredModel);

  const concrete = [];
  const aliases = [];
  const seen = new Set();

  const pushUnique = (rawItem, { aliasBucket = false } = {}) => {
    const entry = normalizeModelEntry(rawItem);
    if (!entry || seen.has(entry.value)) return;
    seen.add(entry.value);
    if (aliasBucket || CLAUDE_ALIAS_IDS.has(entry.value.toLowerCase())) {
      aliases.push(entry);
    } else {
      concrete.push(entry);
    }
  };

  for (const item of gatewayItems) pushUnique(item);
  for (const item of sdkItems) {
    const id = readString(item?.value ?? item?.id ?? item?.model);
    if (id && !CLAUDE_ALIAS_IDS.has(id.toLowerCase())) {
      pushUnique(item);
    }
  }
  for (const item of configuredItems) pushUnique(item);
  for (const item of sdkItems) {
    const id = readString(item?.value ?? item?.id ?? item?.model);
    if (id && CLAUDE_ALIAS_IDS.has(id.toLowerCase())) {
      pushUnique(item, { aliasBucket: true });
    }
  }

  const aliasTargets = {
    default: readString(configuredModel) ?? readString(effectiveEnv.ANTHROPIC_MODEL),
    sonnet: readString(effectiveEnv.ANTHROPIC_DEFAULT_SONNET_MODEL),
    opus: readString(effectiveEnv.ANTHROPIC_DEFAULT_OPUS_MODEL),
    haiku: readString(effectiveEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL),
    fable: readString(effectiveEnv.ANTHROPIC_DEFAULT_FABLE_MODEL),
  };
  for (const item of aliases) {
    const mappedTarget = aliasTargets[item.value.toLowerCase()];
    if (mappedTarget) {
      item.displayName = formatClaudeModelDisplayName(mappedTarget);
    }
  }

  const combined = [...concrete, ...aliases];
  const preferredDefault = readString(configuredModel) ?? readString(effectiveEnv.ANTHROPIC_MODEL);
  if (preferredDefault) {
    for (const item of combined) {
      if (item.value === preferredDefault) {
        item.isDefault = true;
      }
    }
  }
  return combined;
}

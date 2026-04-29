/**
 * Agent configuration utilities.
 *
 * Converts between the profiles.json format used by the backend
 * and the AgentDraft format used by the settings UI forms.
 *
 * Inspired by codeg's acp-agent-settings.tsx dual-sync pattern.
 */

import type { BaseCodingAgent } from 'shared/types';
import type { AgentNativeConfigs } from '@/lib/agentNativeConfig';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface AgentDraft {
  // ── Common ──────────────────────────────────────────────────────────────
  envText: string; // KEY=VALUE format environment variables
  configText: string; // Raw JSON config text (the full agent config object)

  // ── Claude Code ─────────────────────────────────────────────────────────
  claudeApiBaseUrl: string;
  claudeApiKey: string;
  claudeMainModel: string;
  claudeReasoningModel: string;
  claudeDefaultHaikuModel: string;
  claudeDefaultSonnetModel: string;
  claudeDefaultOpusModel: string;

  // ── Codex (struct fields from profiles.json) ────────────────────────────
  codexModel: string;
  codexReasoningEffort: CodexReasoningEffort;

  // ── Codex (native file fields) ──────────────────────────────────────────
  codexApiBaseUrl: string;
  codexApiKey: string;
  codexAuthJsonText: string;
  codexConfigTomlText: string;

  // ── OpenCode (struct fields from profiles.json) ─────────────────────────
  openCodeModel: string;

  // ── OpenCode (native file fields) ───────────────────────────────────────
  openCodeSmallModel: string;
  openCodeConfigText: string;
  openCodeAuthJsonText: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Claude Code environment variable key mappings. */
export const CLAUDE_ENV_KEYS = {
  apiBaseUrl: [
    'ANTHROPIC_BASE_URL',
    'OPENAI_BASE_URL',
    'API_BASE_URL',
  ] as readonly string[],
  apiKey: [
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
  ] as readonly string[],
  mainModel: 'ANTHROPIC_MODEL',
  reasoningModel: 'ANTHROPIC_REASONING_MODEL',
  defaultHaikuModel: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  defaultSonnetModel: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  defaultOpusModel: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
} as const;

/** Codex reasoning effort display options. */
export const CODEX_REASONING_EFFORT_OPTIONS: {
  value: CodexReasoningEffort;
  label: string;
  description: string;
}[] = [
  {
    value: 'low',
    label: 'Low',
    description: '快速响应，适合简单任务',
  },
  {
    value: 'medium',
    label: 'Medium',
    description: '平衡推理深度与响应速度',
  },
  {
    value: 'high',
    label: 'High',
    description: '深度推理，适合复杂问题',
  },
  {
    value: 'xhigh',
    label: 'Extra High',
    description: '最深度推理，适合最复杂的问题',
  },
];

// ---------------------------------------------------------------------------
// Environment variable utilities
// ---------------------------------------------------------------------------

/** Convert an env map to KEY=VALUE text lines. */
export function envMapToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

/** Parse KEY=VALUE text lines into an env map. */
export function parseEnvText(envText: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const rawLine of envText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) {
      map[key] = value;
    }
  }
  return map;
}

/** Patch specific keys in env text without losing other entries. */
export function patchEnvText(
  envText: string,
  patch: Record<string, string | undefined>
): string {
  const existing = parseEnvText(envText);
  const updated = { ...existing };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') {
      delete updated[key];
    } else {
      updated[key] = value;
    }
  }
  return envMapToText(updated);
}

// ---------------------------------------------------------------------------
// Draft builder: profiles config → AgentDraft
// ---------------------------------------------------------------------------

/** Create an empty AgentDraft with sensible defaults. */
export function createEmptyDraft(): AgentDraft {
  return {
    envText: '',
    configText: '{}',
    claudeApiBaseUrl: '',
    claudeApiKey: '',
    claudeMainModel: '',
    claudeReasoningModel: '',
    claudeDefaultHaikuModel: '',
    claudeDefaultSonnetModel: '',
    claudeDefaultOpusModel: '',
    codexModel: '',
    codexReasoningEffort: 'high',
    codexApiBaseUrl: '',
    codexApiKey: '',
    codexAuthJsonText: '',
    codexConfigTomlText: '',
    openCodeModel: '',
    openCodeSmallModel: '',
    openCodeConfigText: '',
    openCodeAuthJsonText: '',
  };
}

/**
 * Build an AgentDraft from the profile config object and native configs.
 *
 * @param agentType - Which agent this config belongs to
 * @param profileConfig - The agent config object from profiles.json
 *                        (e.g. profiles.executors.CLAUDE_CODE.DEFAULT.CLAUDE_CODE)
 * @param nativeConfigs - Native config files read from disk (optional)
 */
export function buildDraftFromProfile(
  agentType: BaseCodingAgent,
  profileConfig: Record<string, unknown>,
  nativeConfigs?: AgentNativeConfigs | null
): AgentDraft {
  const draft = createEmptyDraft();

  // Extract env map from the config's cmd.env or top-level env
  const cmdObj = (profileConfig.cmd ?? {}) as Record<string, unknown>;
  const envMap =
    ((cmdObj.env ?? profileConfig.env ?? {}) as Record<string, string>) || {};
  draft.envText = envMapToText(envMap);
  draft.configText = JSON.stringify(profileConfig, null, 2);

  if (agentType === ('CLAUDE_CODE' as BaseCodingAgent)) {
    // Extract Claude Code specific fields from env
    draft.claudeApiBaseUrl = findEnvValue(envMap, CLAUDE_ENV_KEYS.apiBaseUrl);
    draft.claudeApiKey = findEnvValue(envMap, CLAUDE_ENV_KEYS.apiKey);
    draft.claudeMainModel =
      envMap[CLAUDE_ENV_KEYS.mainModel] ??
      (profileConfig.model as string) ??
      '';
    draft.claudeReasoningModel = envMap[CLAUDE_ENV_KEYS.reasoningModel] ?? '';
    draft.claudeDefaultHaikuModel =
      envMap[CLAUDE_ENV_KEYS.defaultHaikuModel] ?? '';
    draft.claudeDefaultSonnetModel =
      envMap[CLAUDE_ENV_KEYS.defaultSonnetModel] ?? '';
    draft.claudeDefaultOpusModel =
      envMap[CLAUDE_ENV_KEYS.defaultOpusModel] ?? '';
  } else if (agentType === ('CODEX' as BaseCodingAgent)) {
    // Extract Codex struct fields
    draft.codexModel = (profileConfig.model as string) ?? '';
    draft.codexReasoningEffort = normalizeReasoningEffort(
      profileConfig.model_reasoning_effort as string | undefined
    );

    // Native config files
    if (nativeConfigs) {
      draft.codexConfigTomlText = nativeConfigs.codex_config_toml ?? '';
      draft.codexAuthJsonText = nativeConfigs.codex_auth_json ?? '';

      // Extract API key from auth.json
      try {
        if (nativeConfigs.codex_auth_json) {
          const authObj = JSON.parse(nativeConfigs.codex_auth_json);
          draft.codexApiKey = authObj.OPENAI_API_KEY ?? '';
        }
      } catch {
        // Invalid JSON, leave empty
      }

      // Extract base_url and websocket from config.toml
      const tomlValues = extractCodexTomlValues(
        nativeConfigs.codex_config_toml ?? ''
      );
      draft.codexApiBaseUrl = tomlValues.baseUrl;
    }
  } else if (agentType === ('OPENCODE' as BaseCodingAgent)) {
    // Extract OpenCode struct fields
    draft.openCodeModel = (profileConfig.model as string) ?? '';

    // Native config files
    if (nativeConfigs) {
      draft.openCodeConfigText = nativeConfigs.opencode_config_json ?? '';
      draft.openCodeAuthJsonText = nativeConfigs.opencode_auth_json ?? '';

      // Extract small_model from config
      try {
        if (nativeConfigs.opencode_config_json) {
          const configObj = JSON.parse(nativeConfigs.opencode_config_json);
          draft.openCodeSmallModel = configObj.small_model ?? '';
        }
      } catch {
        // Invalid JSON
      }
    }
  }

  return draft;
}

// ---------------------------------------------------------------------------
// Draft builder: AgentDraft → profiles config (for saving)
// ---------------------------------------------------------------------------

/**
 * Build the profile config object from an AgentDraft (for saving to profiles.json).
 * This only handles the profiles.json portion—native files are saved separately.
 */
export function buildProfileConfigFromDraft(
  agentType: BaseCodingAgent,
  draft: AgentDraft,
  existingConfig: Record<string, unknown>
): Record<string, unknown> {
  // Start from existing config to preserve unknown fields
  const config = { ...existingConfig };

  // Build env map from envText + important field overrides
  const envFromText = parseEnvText(draft.envText);

  if (agentType === ('CLAUDE_CODE' as BaseCodingAgent)) {
    // Merge Claude-specific env vars
    const claudeEnv = { ...envFromText };

    if (draft.claudeApiBaseUrl) {
      claudeEnv[CLAUDE_ENV_KEYS.apiBaseUrl[0]] = draft.claudeApiBaseUrl;
    }
    if (draft.claudeApiKey) {
      claudeEnv[CLAUDE_ENV_KEYS.apiKey[0]] = draft.claudeApiKey;
    }
    if (draft.claudeMainModel) {
      claudeEnv[CLAUDE_ENV_KEYS.mainModel] = draft.claudeMainModel;
    }
    if (draft.claudeReasoningModel) {
      claudeEnv[CLAUDE_ENV_KEYS.reasoningModel] = draft.claudeReasoningModel;
    }
    if (draft.claudeDefaultHaikuModel) {
      claudeEnv[CLAUDE_ENV_KEYS.defaultHaikuModel] =
        draft.claudeDefaultHaikuModel;
    }
    if (draft.claudeDefaultSonnetModel) {
      claudeEnv[CLAUDE_ENV_KEYS.defaultSonnetModel] =
        draft.claudeDefaultSonnetModel;
    }
    if (draft.claudeDefaultOpusModel) {
      claudeEnv[CLAUDE_ENV_KEYS.defaultOpusModel] =
        draft.claudeDefaultOpusModel;
    }

    // Update cmd.env
    const cmd = { ...((config.cmd ?? {}) as Record<string, unknown>) };
    cmd.env = Object.keys(claudeEnv).length > 0 ? claudeEnv : undefined;
    config.cmd = cmd;

    // Update model from main model field
    if (draft.claudeMainModel) {
      config.model = draft.claudeMainModel;
    }
  } else if (agentType === ('CODEX' as BaseCodingAgent)) {
    // Codex struct fields
    if (draft.codexModel) {
      config.model = draft.codexModel;
    }
    delete config.model_provider;
    delete config.supports_websockets;
    delete config.reasoning_effort;
    config.model_reasoning_effort = draft.codexReasoningEffort || undefined;

    // Update cmd.env
    const cmd = { ...((config.cmd ?? {}) as Record<string, unknown>) };
    const codexEnv = { ...envFromText };
    cmd.env = Object.keys(codexEnv).length > 0 ? codexEnv : undefined;
    config.cmd = cmd;
  } else if (agentType === ('OPENCODE' as BaseCodingAgent)) {
    // OpenCode struct fields
    if (draft.openCodeModel) {
      config.model = draft.openCodeModel;
    }

    // Update cmd.env
    const cmd = { ...((config.cmd ?? {}) as Record<string, unknown>) };
    const opencodeEnv = { ...envFromText };
    cmd.env = Object.keys(opencodeEnv).length > 0 ? opencodeEnv : undefined;
    config.cmd = cmd;
  }

  return config;
}

// ---------------------------------------------------------------------------
// Codex TOML helpers
// ---------------------------------------------------------------------------

interface CodexTomlValues {
  baseUrl: string;
}

/**
 * Extract important values from a Codex config.toml string.
 * Simple key=value parsing (not a full TOML parser).
 */
export function extractCodexTomlValues(tomlText: string): CodexTomlValues {
  const result: CodexTomlValues = {
    baseUrl: '',
  };

  if (!tomlText) return result;

  for (const line of tomlText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;

    const match = trimmed.match(/^(\w+)\s*=\s*(.+)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    const value = rawValue.replace(/^["']|["']$/g, '').trim();

    if (key === 'base_url') {
      result.baseUrl = value;
    }
  }

  return result;
}

/**
 * Extract provider names from Codex config.toml [model_providers.X] sections.
 */
export function extractCodexProviderOptions(tomlText: string): string[] {
  const providers: string[] = [];

  if (!tomlText) return providers;

  const sectionRegex = /^\[model_providers\.(\w+)\]/;
  for (const line of tomlText.split(/\r?\n/)) {
    const match = line.trim().match(sectionRegex);
    if (match) {
      providers.push(match[1]);
    }
  }

  return providers;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Find the first matching env value from a list of candidate keys. */
function findEnvValue(
  env: Record<string, string>,
  keys: readonly string[]
): string {
  for (const key of keys) {
    if (env[key]) return env[key];
  }
  return '';
}

/** Normalize a reasoning effort string to the expected enum value. */
function normalizeReasoningEffort(
  value: string | undefined
): CodexReasoningEffort {
  if (!value) return 'high';
  const normalized = value.toLowerCase().replace(/-/g, '').trim();
  if (normalized === 'low') return 'low';
  if (normalized === 'medium') return 'medium';
  if (normalized === 'high') return 'high';
  if (normalized === 'xhigh') return 'xhigh';
  return 'high';
}

/**
 * 供应商配置相关类型定义
 * 数据格式与 idea-claude-code-gui 项目完全兼容
 */

// ============ Constants ============

export const STORAGE_KEYS = {
  CODEX_CUSTOM_MODELS: 'codex-custom-models',
  CLAUDE_CUSTOM_MODELS: 'claude-custom-models',
  /** @deprecated Use STORAGE_KEYS from features/models/constants instead for model mapping */
  CLAUDE_MODEL_MAPPING: 'claude-model-mapping',
} as const;

export const LOCAL_SETTINGS_PROVIDER_ID = "__local_settings_json__";

export const MODEL_ID_PATTERN = /^[a-zA-Z0-9._\-/:]+$/;

// ============ Validation Helpers ============

export function isValidModelId(id: string): boolean {
  if (!id || typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return false;
  return true;
}

export function isValidCodexCustomModel(model: unknown): model is CodexCustomModel {
  if (!model || typeof model !== 'object') return false;
  const obj = model as Record<string, unknown>;
  if (typeof obj.id !== 'string' || !isValidModelId(obj.id)) return false;
  if (typeof obj.label !== 'string' || obj.label.trim().length === 0) return false;
  if (obj.description !== undefined && typeof obj.description !== 'string') return false;
  return true;
}

export function validateCodexCustomModels(models: unknown): CodexCustomModel[] {
  if (!Array.isArray(models)) return [];
  return models.filter(isValidCodexCustomModel);
}

// ============ Types ============

export type ProviderCategory =
  | 'official'
  | 'cn_official'
  | 'aggregator'
  | 'third_party'
  | 'custom';

export interface ProviderConfig {
  id: string;
  name: string;
  remark?: string;
  websiteUrl?: string;
  category?: ProviderCategory;
  createdAt?: number;
  isActive?: boolean;
  source?: 'cc-switch' | string;
  isLocalProvider?: boolean;
  settingsConfig?: {
    env?: {
      ANTHROPIC_AUTH_TOKEN?: string;
      ANTHROPIC_BASE_URL?: string;
      ANTHROPIC_MODEL?: string;
      ANTHROPIC_DEFAULT_SONNET_MODEL?: string;
      ANTHROPIC_DEFAULT_OPUS_MODEL?: string;
      ANTHROPIC_DEFAULT_HAIKU_MODEL?: string;
      [key: string]: any;
    };
    alwaysThinkingEnabled?: boolean;
    permissions?: {
      allow?: string[];
      deny?: string[];
    };
  };
}

export interface CodexCustomModel {
  id: string;
  label: string;
  description?: string;
}

export interface ClaudeCurrentConfig {
  apiKey: string;
  baseUrl: string;
  authType?: string;
  providerId?: string;
  providerName?: string;
}

export interface CodexProviderConfig {
  id: string;
  name: string;
  remark?: string;
  createdAt?: number;
  isActive?: boolean;
  configToml?: string;
  authJson?: string;
  customModels?: CodexCustomModel[];
}

export type VendorTab = "claude" | "codex";

export interface ClaudeProviderPreset {
  id: string;
  nameKey: string;
  env: Record<string, string>;
}

export const CLAUDE_PROVIDER_PRESETS: ClaudeProviderPreset[] = [
  {
    id: "custom",
    nameKey: "settings.vendor.presets.custom",
    env: {},
  },
  {
    id: "zhipu",
    nameKey: "settings.vendor.presets.zhipu",
    env: {
      ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: "glm-4.7",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-4.7",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-4.7",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-4.7",
    },
  },
  {
    id: "kimi",
    nameKey: "settings.vendor.presets.kimi",
    env: {
      ANTHROPIC_BASE_URL: "https://api.moonshot.cn/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: "kimi-k2.5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2.5",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "kimi-k2.5",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "kimi-k2.5",
    },
  },
  {
    id: "deepseek",
    nameKey: "settings.vendor.presets.deepseek",
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: "DeepSeek-V3.2",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "DeepSeek-V3.2",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "DeepSeek-V3.2",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "DeepSeek-V3.2",
    },
  },
  {
    id: "minimax",
    nameKey: "settings.vendor.presets.minimax",
    env: {
      ANTHROPIC_BASE_URL: "https://api.minimaxi.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_MODEL: "MiniMax-M2.1",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "MiniMax-M2.1",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "MiniMax-M2.1",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "MiniMax-M2.1",
    },
  },
  {
    id: "xiaomi",
    nameKey: "settings.vendor.presets.xiaomi",
    env: {
      ANTHROPIC_BASE_URL: "https://api.xiaomimimo.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: "mimo-v2-flash",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "mimo-v2-flash",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "mimo-v2-flash",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "mimo-v2-flash",
    },
  },
  {
    id: "qwen",
    nameKey: "settings.vendor.presets.qwen",
    env: {
      ANTHROPIC_BASE_URL: "https://dashscope.aliyuncs.com/apps/anthropic",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: "qwen3-max",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3-max",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3-max",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "qwen3-max",
    },
  },
  {
    id: "openrouter",
    nameKey: "settings.vendor.presets.openrouter",
    env: {
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_MODEL: "anthropic/claude-sonnet-4.5",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "anthropic/claude-haiku-4.5",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "anthropic/claude-sonnet-4.5",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-4.5",
    },
  },
];

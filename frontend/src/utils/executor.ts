import { BaseCodingAgent as BaseCodingAgentEnum } from 'shared/types';
import type {
  AskForApproval,
  BaseCodingAgent,
  ClaudeCode,
  Codex,
  ExecutorAction,
  ExecutorConfigs,
  ExecutorProfileId,
  ExecutionProcess,
  Opencode,
  SandboxMode,
} from 'shared/types';

const RESERVED_KEYS = new Set(['recently_used_models']);

type RuntimeExecutorConfigLike = {
  executor: BaseCodingAgent;
  variant?: string | null;
  model?: string | null;
  model_id?: string | null;
};

type ExecutorVariantRecord<T extends Record<string, unknown>> = {
  variant: string | null;
  record: T;
};

const CLAUDE_CODE_EXECUTOR: BaseCodingAgent = BaseCodingAgentEnum.CLAUDE_CODE;
const CODEX_EXECUTOR: BaseCodingAgent = BaseCodingAgentEnum.CODEX;
const OPENCODE_EXECUTOR: BaseCodingAgent = BaseCodingAgentEnum.OPENCODE;
const CLAUDE_DEFAULT_MODEL = 'sonnet';
const CODEX_DEFAULT_MODEL = 'gpt-5.3-codex';

const CLAUDE_MODEL_LABELS: Record<string, string> = {
  sonnet: 'Sonnet',
  opus: 'Opus',
  haiku: 'Haiku',
};

const CLAUDE_MODEL_ENV_KEYS: Record<string, string> = {
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

const CLAUDE_PRIMARY_MODEL_ENV_KEY = 'ANTHROPIC_MODEL';

const CODEX_MODEL_LABELS: Record<string, string> = {
  'gpt-5.5': 'GPT-5.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.2-codex': 'GPT-5.2 Codex',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
};

const OPENCODE_ZEN_FALLBACK_MODELS = [
  'opencode/kimi-k2.5',
  'opencode/qwen3.5-plus',
  'opencode/claude-haiku-4-5',
  'opencode/glm-5.1',
  'opencode/gemini-3.5-flash',
  'opencode/gpt-5.2',
  'opencode/gpt-5.4-nano',
  'opencode/gpt-5.5-pro',
  'opencode/gpt-5.1-codex-mini',
  'opencode/claude-sonnet-4-5',
  'opencode/gpt-5.3-codex-spark',
  'opencode/grok-build-0.1',
  'opencode/deepseek-v4-flash-free',
  'opencode/gpt-5-codex',
  'opencode/minimax-m2.5',
  'opencode/claude-sonnet-4-6',
  'opencode/qwen3.6-plus-free',
  'opencode/minimax-m2.7',
  'opencode/claude-opus-4-1',
  'opencode/qwen3.6-plus',
  'opencode/gpt-5.1',
  'opencode/gpt-5-nano',
  'opencode/gpt-5.4-mini',
  'opencode/claude-opus-4-7',
  'opencode/gemini-3-flash',
  'opencode/gpt-5.1-codex-max',
  'opencode/gpt-5.4-pro',
  'opencode/big-pickle',
  'opencode/claude-sonnet-4',
  'opencode/gpt-5.1-codex',
  'opencode/gpt-5.2-codex',
  'opencode/gpt-5.3-codex',
  'opencode/nemotron-3-super-free',
  'opencode/glm-5',
  'opencode/gemini-3.1-pro',
  'opencode/kimi-k2.6',
  'opencode/claude-opus-4-5',
  'opencode/gpt-5',
  'opencode/gpt-5.4',
  'opencode/gpt-5.5',
  'opencode/claude-opus-4-6',
];

export type ClaudePermissionMode = 'auto' | 'ask' | 'plan';
export type CodexPermissionMode = 'auto' | 'ask';
export type OpenCodePermissionMode = 'auto' | 'ask';
export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export const CODEX_REASONING_EFFORT_OPTIONS: ReadonlyArray<{
  value: CodexReasoningEffort;
  label: string;
  description: string;
}> = [
  {
    value: 'low',
    label: 'Low',
    description: 'Fast responses with lighter reasoning',
  },
  {
    value: 'medium',
    label: 'Medium',
    description: 'Balances speed and reasoning depth',
  },
  {
    value: 'high',
    label: 'High',
    description: 'Greater reasoning depth for complex problems',
  },
  {
    value: 'xhigh',
    label: 'Extra High',
    description: 'Maximum reasoning depth for hardest problems',
  },
];

export const CODEX_DEFAULT_REASONING_EFFORT: CodexReasoningEffort = 'high';
export const CODEX_DEFAULT_SANDBOX_MODE: SandboxMode = 'danger-full-access';
export const CODEX_DEFAULT_APPROVAL_POLICY: AskForApproval = 'never';

export type CodexModelOption = {
  value: string | null;
  label: string;
};

export function mergeModelOptions(
  baseOptions: CodexModelOption[],
  extraOptions: CodexModelOption[],
  currentModel: string | null = null
): CodexModelOption[] {
  const seen = new Set<string>();
  const merged: CodexModelOption[] = [];

  for (const option of [...baseOptions, ...extraOptions]) {
    const key = option.value ?? 'DEFAULT';
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(option);
  }

  if (currentModel && !seen.has(currentModel)) {
    merged.push({
      value: currentModel,
      label: formatSimpleLabel(currentModel),
    });
  }

  return merged;
}

export type ClaudeVariantConfig = {
  model: string | null;
  permissionMode: ClaudePermissionMode;
  variant: string | null;
};

export type CodexVariantConfig = {
  model: string | null;
  sandbox: SandboxMode;
  approvalPolicy: AskForApproval;
  permissionMode: CodexPermissionMode;
  reasoningEffort: CodexReasoningEffort;
  variant: string | null;
};

export type OpenCodeVariantConfig = {
  model: string | null;
  agentMode: string | null;
  autoApprove: boolean;
  permissionMode: OpenCodePermissionMode;
  variant: string | null;
};

function formatSimpleLabel(value: string | null): string {
  if (!value) return 'Default';

  return value
    .replace(/[_-]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((part) => {
      if (/^[a-z]+$/i.test(part) && part.length <= 3) {
        return part.toUpperCase();
      }

      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function getExecutorVariantRecord<T extends Record<string, unknown>>(
  profiles: ExecutorConfigs['executors'] | null | undefined,
  executor: BaseCodingAgent,
  variant: string | null
): T | null {
  const executorProfiles = profiles?.[executor] as
    | Record<string, unknown>
    | undefined;
  if (!executorProfiles) return null;

  const variantKey = variant ?? 'DEFAULT';
  const variantEntry = executorProfiles[variantKey] as
    | Record<string, unknown>
    | undefined;
  if (!variantEntry) return null;

  return (variantEntry[executor] as T | undefined) ?? null;
}

function getExecutorVariantRecords<T extends Record<string, unknown>>(
  profiles: ExecutorConfigs['executors'] | null | undefined,
  executor: BaseCodingAgent
): ExecutorVariantRecord<T>[] {
  return getVariantOptions(executor, profiles)
    .map((variantKey) => {
      const variant = variantKey === 'DEFAULT' ? null : variantKey;
      const record = getExecutorVariantRecord<T>(profiles, executor, variant);

      if (!record) return null;

      return { variant, record };
    })
    .filter((entry): entry is ExecutorVariantRecord<T> => entry !== null);
}

function findBestMatchingVariant<T extends { variant: string | null }>(
  variants: T[],
  scoreVariant: (variant: T) => number
): string | null {
  let bestVariant: T | null = null;
  let bestScore = -1;

  for (const variant of variants) {
    const score = scoreVariant(variant);
    if (score > bestScore) {
      bestVariant = variant;
      bestScore = score;
    }
  }

  return bestVariant?.variant ?? null;
}

export function getExecutorVariantKeys(
  executorProfile: Record<string, unknown> | null | undefined
): string[] {
  return Object.keys(executorProfile || {}).filter(
    (key) => !RESERVED_KEYS.has(key)
  );
}

export function getSortedExecutorVariantKeys(
  executorProfile: Record<string, unknown> | null | undefined
): string[] {
  return getExecutorVariantKeys(executorProfile).sort((a, b) => {
    if (a === 'DEFAULT') return -1;
    if (b === 'DEFAULT') return 1;
    return a.localeCompare(b);
  });
}

export function isClaudeCodeExecutor(
  executor: BaseCodingAgent | null | undefined
): boolean {
  return executor === CLAUDE_CODE_EXECUTOR;
}

export function getDefaultVariantForExecutor(
  executor: BaseCodingAgent | null | undefined,
  profiles: ExecutorConfigs['executors'] | null | undefined
): string | null {
  const variants = getVariantOptions(executor, profiles);
  if (variants.length === 0) return null;

  const preferred = variants.includes('DEFAULT') ? 'DEFAULT' : variants[0];
  return preferred === 'DEFAULT' ? null : preferred;
}

export function getDefaultProfileForExecutor(
  executor: BaseCodingAgent | null | undefined,
  profiles: ExecutorConfigs['executors'] | null | undefined
): ExecutorProfileId | null {
  if (!executor) return null;

  return {
    executor,
    variant: getDefaultVariantForExecutor(executor, profiles),
  };
}

export function getFirstAvailableProfile(
  profiles: ExecutorConfigs['executors'] | null | undefined
): ExecutorProfileId | null {
  if (!profiles) return null;

  const executors = Object.keys(profiles).sort() as BaseCodingAgent[];
  const firstExecutor = executors[0];
  if (!firstExecutor) return null;

  return getDefaultProfileForExecutor(firstExecutor, profiles);
}

/**
 * Compare two ExecutorProfileIds for equality.
 * Treats null/undefined variant as equivalent to "DEFAULT".
 */
export function areProfilesEqual(
  a: ExecutorProfileId | null | undefined,
  b: ExecutorProfileId | null | undefined
): boolean {
  if (!a || !b) return a === b;
  if (a.executor !== b.executor) return false;

  const variantA = a.variant ?? 'DEFAULT';
  const variantB = b.variant ?? 'DEFAULT';
  const modelA = a.model ?? 'DEFAULT';
  const modelB = b.model ?? 'DEFAULT';
  return variantA === variantB && modelA === modelB;
}

/**
 * Get variant options for a given executor from profiles.
 * Returns variants sorted: DEFAULT first, then alphabetically.
 */
export function getVariantOptions(
  executor: BaseCodingAgent | null | undefined,
  profiles: ExecutorConfigs['executors'] | null | undefined
): string[] {
  if (!executor || !profiles) return [];
  const executorConfig = profiles[executor];
  if (!executorConfig) return [];

  return getSortedExecutorVariantKeys(
    executorConfig as Record<string, unknown>
  );
}

export function getClaudeVariantConfig(
  profiles: ExecutorConfigs['executors'] | null | undefined,
  variant: string | null
): ClaudeVariantConfig {
  const record = getExecutorVariantRecord<ClaudeCode>(
    profiles,
    CLAUDE_CODE_EXECUTOR,
    variant
  );

  return {
    model:
      typeof record?.model === 'string' ? record.model : CLAUDE_DEFAULT_MODEL,
    permissionMode: record?.plan ? 'plan' : record?.approvals ? 'ask' : 'auto',
    variant,
  };
}

export function getClaudePermissionOptions(
  profiles: ExecutorConfigs['executors'] | null | undefined
): ClaudePermissionMode[] {
  const seen = new Set<ClaudePermissionMode>();
  const options: ClaudePermissionMode[] = [];

  for (const entry of getExecutorVariantRecords<ClaudeCode>(
    profiles,
    CLAUDE_CODE_EXECUTOR
  )) {
    const permissionMode = getClaudeVariantConfig(
      profiles,
      entry.variant
    ).permissionMode;
    if (seen.has(permissionMode)) continue;
    seen.add(permissionMode);
    options.push(permissionMode);
  }

  return options;
}

export function getClaudeModelOptions(
  profiles: ExecutorConfigs['executors'] | null | undefined,
  claudeEnv: Record<string, string> | null | undefined = undefined
): CodexModelOption[] {
  const seen = new Set<string>();
  const options: CodexModelOption[] = [];
  const hasLocalModelConfig =
    !!claudeEnv?.[CLAUDE_PRIMARY_MODEL_ENV_KEY]?.trim() ||
    Object.values(CLAUDE_MODEL_ENV_KEYS).some((key) =>
      Boolean(claudeEnv?.[key]?.trim())
    );

  for (const entry of getExecutorVariantRecords<ClaudeCode>(
    profiles,
    CLAUDE_CODE_EXECUTOR
  )) {
    const model = getClaudeVariantConfig(profiles, entry.variant).model;
    const modelKey = model ?? CLAUDE_DEFAULT_MODEL;
    const resolvedModel = resolveClaudeModelFromEnv(model, claudeEnv);
    if (hasLocalModelConfig && !resolvedModel) continue;
    if (seen.has(modelKey)) continue;
    seen.add(modelKey);
    options.push({
      value: model,
      label: formatClaudeModelLabel(model, claudeEnv),
    });
  }

  if (
    options.length === 0 ||
    (!hasLocalModelConfig && !seen.has(CLAUDE_DEFAULT_MODEL))
  ) {
    options.unshift({
      value: CLAUDE_DEFAULT_MODEL,
      label: formatClaudeModelLabel(CLAUDE_DEFAULT_MODEL, claudeEnv),
    });
  }

  return options;
}

function resolveClaudeModelFromEnv(
  model: string | null,
  claudeEnv: Record<string, string> | null | undefined = undefined
): string | null {
  const modelKey = model ?? CLAUDE_DEFAULT_MODEL;
  const aliasEnvKey = CLAUDE_MODEL_ENV_KEYS[modelKey];
  const aliasModel = aliasEnvKey ? claudeEnv?.[aliasEnvKey]?.trim() : null;
  if (aliasModel) return aliasModel;

  if (modelKey === CLAUDE_DEFAULT_MODEL) {
    const primaryModel = claudeEnv?.[CLAUDE_PRIMARY_MODEL_ENV_KEY]?.trim();
    if (primaryModel) return primaryModel;
  }

  if (!CLAUDE_MODEL_LABELS[modelKey]) return modelKey;
  return null;
}

export function formatClaudeModelLabel(
  model: string | null,
  claudeEnv: Record<string, string> | null | undefined = undefined
): string {
  const modelKey = model ?? CLAUDE_DEFAULT_MODEL;
  const resolvedModel = resolveClaudeModelFromEnv(model, claudeEnv);

  if (resolvedModel && resolvedModel !== modelKey) {
    return resolvedModel;
  }

  return CLAUDE_MODEL_LABELS[modelKey] ?? formatSimpleLabel(modelKey);
}

export function getClaudeVariantFromSelection(
  profiles: ExecutorConfigs['executors'] | null | undefined,
  permissionMode: ClaudePermissionMode,
  selectedModel: string | null
): string | null {
  const variants = getExecutorVariantRecords<ClaudeCode>(
    profiles,
    CLAUDE_CODE_EXECUTOR
  ).map((entry) => getClaudeVariantConfig(profiles, entry.variant));

  const exactMatch = variants.find(
    (config) =>
      config.permissionMode === permissionMode && config.model === selectedModel
  );
  if (exactMatch) return exactMatch.variant;

  return findBestMatchingVariant(variants, (config) => {
    let score = 0;
    if (config.permissionMode === permissionMode) score += 2;
    if (config.model === selectedModel) score += 1;
    return score;
  });
}

export function getCodexVariantConfig(
  profiles: ExecutorConfigs['executors'] | null | undefined,
  variant: string | null
): CodexVariantConfig {
  const record = getExecutorVariantRecord<Codex>(
    profiles,
    CODEX_EXECUTOR,
    variant
  );
  const approvalPolicy =
    typeof record?.ask_for_approval === 'string'
      ? (record.ask_for_approval as AskForApproval)
      : CODEX_DEFAULT_APPROVAL_POLICY;
  const sandbox =
    typeof record?.sandbox === 'string'
      ? (record.sandbox as SandboxMode)
      : CODEX_DEFAULT_SANDBOX_MODE;
  const model =
    typeof record?.model === 'string' ? record.model : CODEX_DEFAULT_MODEL;
  const reasoningEffort =
    typeof record?.model_reasoning_effort === 'string'
      ? (record.model_reasoning_effort as CodexReasoningEffort)
      : CODEX_DEFAULT_REASONING_EFFORT;

  return {
    model,
    sandbox,
    approvalPolicy,
    permissionMode: approvalPolicy !== 'never' ? 'ask' : 'auto',
    reasoningEffort,
    variant,
  };
}

export function formatCodexModelLabel(model: string | null): string {
  if (!model) return formatCodexModelLabel(CODEX_DEFAULT_MODEL);
  return CODEX_MODEL_LABELS[model] ?? formatSimpleLabel(model);
}

export function getCodexModelOptions(
  profiles: ExecutorConfigs['executors'] | null | undefined
): CodexModelOption[] {
  const variants = getVariantOptions(CODEX_EXECUTOR, profiles);
  const seen = new Set<string>();
  const options: CodexModelOption[] = [];

  for (const variantKey of variants) {
    const variant = variantKey === 'DEFAULT' ? null : variantKey;
    const model = getCodexVariantConfig(profiles, variant).model;
    const modelKey = model ?? CODEX_DEFAULT_MODEL;
    if (seen.has(modelKey)) continue;

    seen.add(modelKey);
    options.push({
      value: model,
      label: formatCodexModelLabel(model),
    });
  }

  const sortPriority = (value: string | null): number => {
    switch (value) {
      case 'gpt-5.5':
        return 0;
      case 'gpt-5.3-codex':
        return 1;
      case 'gpt-5.4':
        return 2;
      case 'gpt-5.4-mini':
        return 3;
      case 'gpt-5.1-codex-max':
        return 4;
      case 'gpt-5.2':
        return 5;
      case 'gpt-5.2-codex':
        return 6;
      case null:
        return 99;
      default:
        return 50;
    }
  };

  if (!seen.has(CODEX_DEFAULT_MODEL)) {
    options.push({
      value: CODEX_DEFAULT_MODEL,
      label: formatCodexModelLabel(CODEX_DEFAULT_MODEL),
    });
  }

  return options
    .filter((option) => option.value !== null)
    .sort((a, b) => sortPriority(a.value) - sortPriority(b.value));
}

export function getCodexSandboxOptions(
  profiles: ExecutorConfigs['executors'] | null | undefined
): SandboxMode[] {
  const seen = new Set<SandboxMode>();
  const options: SandboxMode[] = [];

  for (const entry of getExecutorVariantRecords<Codex>(
    profiles,
    CODEX_EXECUTOR
  )) {
    const sandbox = getCodexVariantConfig(profiles, entry.variant).sandbox;
    if (seen.has(sandbox)) continue;
    seen.add(sandbox);
    options.push(sandbox);
  }

  return options;
}

export function getCodexApprovalOptions(
  profiles: ExecutorConfigs['executors'] | null | undefined
): AskForApproval[] {
  const seen = new Set<AskForApproval>();
  const options: AskForApproval[] = [];

  for (const entry of getExecutorVariantRecords<Codex>(
    profiles,
    CODEX_EXECUTOR
  )) {
    const approvalPolicy = getCodexVariantConfig(
      profiles,
      entry.variant
    ).approvalPolicy;
    if (seen.has(approvalPolicy)) continue;
    seen.add(approvalPolicy);
    options.push(approvalPolicy);
  }

  return options;
}

export function getCodexReasoningOptions(
  profiles: ExecutorConfigs['executors'] | null | undefined
): CodexReasoningEffort[] {
  const seen = new Set<CodexReasoningEffort>();
  const options: CodexReasoningEffort[] = [];

  for (const entry of getExecutorVariantRecords<Codex>(
    profiles,
    CODEX_EXECUTOR
  )) {
    const reasoningEffort = getCodexVariantConfig(
      profiles,
      entry.variant
    ).reasoningEffort;
    if (seen.has(reasoningEffort)) continue;
    seen.add(reasoningEffort);
    options.push(reasoningEffort);
  }

  return options;
}

export function getCodexVariantFromSelection(
  profiles: ExecutorConfigs['executors'] | null | undefined,
  selectedModel: string | null,
  permissionMode: CodexPermissionMode,
  reasoningEffort: CodexReasoningEffort = CODEX_DEFAULT_REASONING_EFFORT
): string | null {
  const variants = getVariantOptions(CODEX_EXECUTOR, profiles);

  const matchedVariant = variants.find((variantKey) => {
    const variant = variantKey === 'DEFAULT' ? null : variantKey;
    const config = getCodexVariantConfig(profiles, variant);
    return (
      config.model === selectedModel &&
      config.permissionMode === permissionMode &&
      config.reasoningEffort === reasoningEffort
    );
  });

  if (!matchedVariant) {
    return getDefaultVariantForExecutor(CODEX_EXECUTOR, profiles);
  }

  return matchedVariant === 'DEFAULT' ? null : matchedVariant;
}

export function getCodexVariantFromConfigSelection(
  profiles: ExecutorConfigs['executors'] | null | undefined,
  selection: {
    model: string | null;
    sandbox: SandboxMode;
    approvalPolicy: AskForApproval;
    reasoningEffort: CodexReasoningEffort;
  }
): string | null {
  const variants = getExecutorVariantRecords<Codex>(
    profiles,
    CODEX_EXECUTOR
  ).map((entry) => getCodexVariantConfig(profiles, entry.variant));

  const exactMatch = variants.find(
    (config) =>
      config.model === selection.model &&
      config.sandbox === selection.sandbox &&
      config.approvalPolicy === selection.approvalPolicy &&
      config.reasoningEffort === selection.reasoningEffort
  );
  if (exactMatch) return exactMatch.variant;

  return findBestMatchingVariant(variants, (config) => {
    let score = 0;
    if (config.model === selection.model) score += 4;
    if (config.sandbox === selection.sandbox) score += 3;
    if (config.approvalPolicy === selection.approvalPolicy) score += 2;
    if (config.reasoningEffort === selection.reasoningEffort) score += 1;
    return score;
  });
}

export function getOpenCodeVariantConfig(
  profiles: ExecutorConfigs['executors'] | null | undefined,
  variant: string | null
): OpenCodeVariantConfig {
  const record = getExecutorVariantRecord<Opencode>(
    profiles,
    OPENCODE_EXECUTOR,
    variant
  );

  return {
    model: typeof record?.model === 'string' ? record.model : null,
    agentMode: typeof record?.agent === 'string' ? record.agent : null,
    autoApprove: record?.auto_approve ?? true,
    permissionMode: (record?.auto_approve ?? true) ? 'auto' : 'ask',
    variant,
  };
}

export function getOpenCodePermissionOptions(
  profiles: ExecutorConfigs['executors'] | null | undefined
): OpenCodePermissionMode[] {
  const seen = new Set<OpenCodePermissionMode>();
  const options: OpenCodePermissionMode[] = [];

  for (const entry of getExecutorVariantRecords<Opencode>(
    profiles,
    OPENCODE_EXECUTOR
  )) {
    const permissionMode = getOpenCodeVariantConfig(
      profiles,
      entry.variant
    ).permissionMode;
    if (seen.has(permissionMode)) continue;
    seen.add(permissionMode);
    options.push(permissionMode);
  }

  return options;
}

export function getOpenCodeModeOptions(
  profiles: ExecutorConfigs['executors'] | null | undefined
): Array<string | null> {
  const seen = new Set<string>();
  const options: Array<string | null> = [];

  for (const entry of getExecutorVariantRecords<Opencode>(
    profiles,
    OPENCODE_EXECUTOR
  )) {
    const agentMode = getOpenCodeVariantConfig(
      profiles,
      entry.variant
    ).agentMode;
    const modeKey = agentMode ?? 'DEFAULT';
    if (seen.has(modeKey)) continue;
    seen.add(modeKey);
    options.push(agentMode);
  }

  return options;
}

export function getOpenCodeModelOptions(
  profiles: ExecutorConfigs['executors'] | null | undefined
): CodexModelOption[] {
  const seen = new Set<string>();
  const options: CodexModelOption[] = [];
  const pushOption = (model: string | null) => {
    if (!model) return;
    const modelKey = model ?? 'DEFAULT';
    if (seen.has(modelKey)) return;
    seen.add(modelKey);
    options.push({
      value: model,
      label: formatSimpleLabel(model),
    });
  };

  for (const entry of getExecutorVariantRecords<Opencode>(
    profiles,
    OPENCODE_EXECUTOR
  )) {
    pushOption(getOpenCodeVariantConfig(profiles, entry.variant).model);
  }

  for (const model of OPENCODE_ZEN_FALLBACK_MODELS) {
    pushOption(model);
  }

  return options;
}

export function getOpenCodeVariantFromSelection(
  profiles: ExecutorConfigs['executors'] | null | undefined,
  selection: {
    model: string | null;
    agentMode: string | null;
    permissionMode: OpenCodePermissionMode;
  }
): string | null {
  const variants = getExecutorVariantRecords<Opencode>(
    profiles,
    OPENCODE_EXECUTOR
  ).map((entry) => getOpenCodeVariantConfig(profiles, entry.variant));

  const exactMatch = variants.find(
    (config) =>
      config.model === selection.model &&
      config.agentMode === selection.agentMode &&
      config.permissionMode === selection.permissionMode
  );
  if (exactMatch) return exactMatch.variant;

  return findBestMatchingVariant(variants, (config) => {
    let score = 0;
    if (config.model === selection.model) score += 3;
    if (config.agentMode === selection.agentMode) score += 2;
    if (config.permissionMode === selection.permissionMode) score += 1;
    return score;
  });
}

export function formatSandboxModeLabel(mode: SandboxMode): string {
  switch (mode) {
    case 'danger-full-access':
      return 'Full Access';
    case 'workspace-write':
      return 'Workspace Write';
    case 'read-only':
      return 'Read Only';
    case 'auto':
    default:
      return 'Auto';
  }
}

export function formatApprovalPolicyLabel(policy: AskForApproval): string {
  switch (policy) {
    case 'unless-trusted':
      return 'Ask';
    case 'on-failure':
      return 'On Failure';
    case 'on-request':
      return 'On Request';
    case 'never':
    default:
      return 'Never';
  }
}

export function formatClaudePermissionLabel(
  permissionMode: ClaudePermissionMode
): string {
  switch (permissionMode) {
    case 'plan':
      return 'Plan';
    case 'ask':
      return 'Ask';
    case 'auto':
    default:
      return 'Auto';
  }
}

export function formatOpenCodeModeLabel(mode: string | null): string {
  return formatSimpleLabel(mode);
}

export function formatOpenCodePermissionLabel(
  mode: OpenCodePermissionMode
): string {
  return mode === 'auto' ? 'Auto Approve' : 'Ask';
}

function toProfileId(
  value: RuntimeExecutorConfigLike | ExecutorProfileId | null | undefined
): ExecutorProfileId | null {
  if (!value?.executor) return null;
  const modelId = 'model_id' in value ? value.model_id : null;

  return {
    executor: value.executor,
    variant: value.variant ?? null,
    model: value.model ?? modelId ?? null,
  };
}

/**
 * Extract ExecutorProfileId from an ExecutorAction chain.
 * Traverses the action chain to find the first coding agent request.
 */
export function extractProfileFromAction(
  action: ExecutorAction | null
): ExecutorProfileId | null {
  let curr: ExecutorAction | null = action;
  while (curr) {
    const typ = curr.typ;
    switch (typ.type) {
      case 'CodingAgentInitialRequest':
      case 'CodingAgentFollowUpRequest':
      case 'ReviewRequest':
        return toProfileId(
          (
            typ as {
              executor_profile_id?: ExecutorProfileId;
              executor_config?: RuntimeExecutorConfigLike;
            }
          ).executor_profile_id ??
            (
              typ as {
                executor_profile_id?: ExecutorProfileId;
                executor_config?: RuntimeExecutorConfigLike;
              }
            ).executor_config
        );
      case 'ScriptRequest':
      default:
        curr = curr.next_action;
        continue;
    }
  }
  return null;
}

/**
 * Get the latest ExecutorProfileId from a list of execution processes.
 * Searches from most recent to oldest.
 */
export function getLatestProfileFromProcesses(
  processes: ExecutionProcess[] | undefined
): ExecutorProfileId | null {
  if (!processes?.length) return null;
  return (
    processes
      .slice()
      .reverse()
      .map((p) => extractProfileFromAction(p.executor_action ?? null))
      .find((pid) => pid !== null) ?? null
  );
}

import { BaseCodingAgent as BaseCodingAgentEnum } from 'shared/types';
import type {
  BaseCodingAgent,
  ExecutorConfigs,
  ExecutorAction,
  ExecutorProfileId,
  ExecutionProcess,
} from 'shared/types';

const RESERVED_KEYS = new Set(['recently_used_models']);

type RuntimeExecutorConfigLike = {
  executor: BaseCodingAgent;
  variant?: string | null;
};

const CODEX_EXECUTOR: BaseCodingAgent = BaseCodingAgentEnum.CODEX;
const CODEX_MODEL_LABELS: Record<string, string> = {
  'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.2-codex': 'GPT-5.2 Codex',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
};

export type CodexPermissionMode = 'auto' | 'ask';

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export const CODEX_REASONING_EFFORT_OPTIONS: ReadonlyArray<{
  value: CodexReasoningEffort;
  label: string;
  description: string;
}> = [
  { value: 'low', label: 'Low', description: '快速响应，推理较轻' },
  { value: 'medium', label: 'Medium', description: '平衡速度和推理深度' },
  { value: 'high', label: 'High', description: '更高的推理深度' },
  { value: 'xhigh', label: 'Extra High', description: '极高的推理深度' },
];

export const CODEX_DEFAULT_REASONING_EFFORT: CodexReasoningEffort = 'high';

export type CodexModelOption = {
  value: string | null;
  label: string;
};

export type CodexVariantConfig = {
  model: string | null;
  permissionMode: CodexPermissionMode;
  reasoningEffort: CodexReasoningEffort;
  variant: string | null;
};

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
  return executor === 'CLAUDE_CODE';
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
  // Normalize variants: null/undefined -> 'DEFAULT'
  const variantA = a.variant ?? 'DEFAULT';
  const variantB = b.variant ?? 'DEFAULT';
  return variantA === variantB;
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

function getCodexVariantRecord(
  profiles: ExecutorConfigs['executors'] | null | undefined,
  variant: string | null
): Record<string, unknown> | null {
  const executorProfiles = profiles?.[CODEX_EXECUTOR] as
    | Record<string, unknown>
    | undefined;
  if (!executorProfiles) return null;

  const variantKey = variant ?? 'DEFAULT';
  const variantEntry = executorProfiles[variantKey] as
    | Record<string, unknown>
    | undefined;
  if (!variantEntry) return null;

  return (variantEntry[CODEX_EXECUTOR] as Record<string, unknown> | undefined) ?? null;
}

export function getCodexVariantConfig(
  profiles: ExecutorConfigs['executors'] | null | undefined,
  variant: string | null
): CodexVariantConfig {
  const record = getCodexVariantRecord(profiles, variant);
  const askForApproval = record?.ask_for_approval;
  const model = typeof record?.model === 'string' ? record.model : null;
  const reasoningEffort = typeof record?.model_reasoning_effort === 'string'
    ? record.model_reasoning_effort as CodexReasoningEffort
    : CODEX_DEFAULT_REASONING_EFFORT;

  return {
    model,
    permissionMode:
      typeof askForApproval === 'string' && askForApproval !== 'never'
        ? 'ask'
        : 'auto',
    reasoningEffort,
    variant,
  };
}

export function formatCodexModelLabel(model: string | null): string {
  if (!model) return 'Default';
  return CODEX_MODEL_LABELS[model] ?? model;
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
    const modelKey = model ?? 'DEFAULT';
    if (seen.has(modelKey)) continue;

    seen.add(modelKey);
    options.push({
      value: model,
      label: formatCodexModelLabel(model),
    });
  }

  const sortPriority = (value: string | null): number => {
    switch (value) {
      case 'gpt-5.1-codex-max':
        return 0;
      case 'gpt-5.2':
        return 1;
      case 'gpt-5.2-codex':
        return 2;
      case 'gpt-5.3-codex':
        return 3;
      case null:
        return 99;
      default:
        return 50;
    }
  };

  return (options.length > 0 ? options : [{ value: null, label: 'Default' }]).sort(
    (a, b) => sortPriority(a.value) - sortPriority(b.value)
  );
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
    return config.model === selectedModel &&
      config.permissionMode === permissionMode &&
      config.reasoningEffort === reasoningEffort;
  });

  if (!matchedVariant) {
    return getDefaultVariantForExecutor(CODEX_EXECUTOR, profiles);
  }

  return matchedVariant === 'DEFAULT' ? null : matchedVariant;
}

function toProfileId(
  value: RuntimeExecutorConfigLike | ExecutorProfileId | null | undefined
): ExecutorProfileId | null {
  if (!value?.executor) return null;

  return {
    executor: value.executor,
    variant: value.variant ?? null,
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
          (typ as {
            executor_profile_id?: ExecutorProfileId;
            executor_config?: RuntimeExecutorConfigLike;
          }).executor_profile_id ??
            (typ as {
              executor_profile_id?: ExecutorProfileId;
              executor_config?: RuntimeExecutorConfigLike;
            }).executor_config
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

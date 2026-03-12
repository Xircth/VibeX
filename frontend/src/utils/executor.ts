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

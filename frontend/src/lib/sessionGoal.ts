import type { ConversationSessionGoal, JsonValue } from 'shared/types';

export type SessionGoalStatus =
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'limited'
  | 'budget_limited'
  | 'usage_limited';

export interface ParsedSessionGoal {
  objective: string;
  status: SessionGoalStatus;
  summary: string | null;
  tokensUsed: number | null;
  tokenBudget: number | null;
  tokensRemaining: number | null;
  durationMs: number | null;
  updatedAt: string | null;
  actions: string[] | null;
  canPause: boolean;
  canClear: boolean;
  isLiveBarVisible: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readNonEmptyString(
  record: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function readFiniteNumber(
  record: Record<string, unknown>,
  ...keys: string[]
): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
    if (typeof value === 'bigint' && value >= 0n) {
      return Number(value);
    }
  }
  return null;
}

export function normalizeSessionGoalStatus(raw: unknown): SessionGoalStatus {
  if (typeof raw !== 'string') return 'active';
  const trimmed = raw.trim();
  const snake = trimmed.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  switch (snake) {
    case 'active':
    case 'running':
    case 'in_progress':
      return 'active';
    case 'paused':
      return 'paused';
    case 'completed':
    case 'complete':
    case 'done':
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'budget_limited':
      return 'budget_limited';
    case 'usage_limited':
      return 'usage_limited';
    case 'limited':
    case 'rate_limited':
      return 'limited';
    default:
      return 'active';
  }
}

export function isLimitedGoalStatus(status: SessionGoalStatus): boolean {
  return (
    status === 'blocked' ||
    status === 'limited' ||
    status === 'budget_limited' ||
    status === 'usage_limited'
  );
}

export function parseSessionGoalValue(
  rawGoal: JsonValue | unknown,
  options?: {
    actions?: string[] | null;
    sessionBindReady?: boolean;
  }
): ParsedSessionGoal | null {
  const outer = asRecord(rawGoal);
  if (!outer) return null;
  const record = asRecord(outer.goal) ?? outer;
  const objective = readNonEmptyString(
    record,
    'objective',
    'goal',
    'text',
    'description',
    'title'
  );
  if (!objective) return null;

  const status = normalizeSessionGoalStatus(
    record.status ?? record.state ?? outer.status ?? outer.state
  );
  const summary = readNonEmptyString(record, 'summary', 'message', 'reason');
  const tokensUsed = readFiniteNumber(record, 'tokensUsed', 'tokens_used');
  const tokenBudget = readFiniteNumber(record, 'tokenBudget', 'token_budget');
  const tokensRemaining = readFiniteNumber(
    record,
    'tokensRemaining',
    'tokens_remaining'
  );
  const durationMs = readFiniteNumber(record, 'durationMs', 'duration_ms');
  const updatedAt = readNonEmptyString(record, 'updatedAt', 'updated_at');

  const actions = options?.actions ?? null;
  const bindReady = options?.sessionBindReady ?? true;
  const actionSet = Array.isArray(actions) ? new Set(actions) : null;
  const canPause = Boolean(
    bindReady && actionSet?.has('pause') && status === 'active'
  );
  const canClear = Boolean(
    bindReady &&
      actionSet?.has('clear') &&
      (status === 'active' || status === 'paused')
  );
  const isLiveBarVisible = status === 'active' || status === 'paused';

  return {
    objective,
    status,
    summary,
    tokensUsed,
    tokenBudget,
    tokensRemaining,
    durationMs,
    updatedAt,
    actions,
    canPause,
    canClear,
    isLiveBarVisible,
  };
}

export function parseConversationSessionGoal(
  sessionGoal: ConversationSessionGoal | null | undefined,
  options?: { sessionBindReady?: boolean }
): ParsedSessionGoal | null {
  if (!sessionGoal || sessionGoal.goal == null) return null;
  return parseSessionGoalValue(sessionGoal.goal, {
    actions: sessionGoal.actions ?? null,
    sessionBindReady: options?.sessionBindReady ?? true,
  });
}

export function formatGoalTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (tokens >= 10_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return tokens.toLocaleString();
}

export function formatGoalDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

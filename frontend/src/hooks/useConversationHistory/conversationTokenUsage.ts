import type { AgentUsage, TokenUsageInfo } from 'shared/types';
import type { ExecutionProcessStateStore } from './types';
import { dateTimestamp } from '@/utils/date';

export type ConversationUsageSnapshot = {
  totalTokens: number;
  contextWindow: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
};

type AgentUsageLike = {
  used: number | bigint;
  limit?: number | bigint | null;
};

function usageNumber(value: number | bigint | null | undefined): number | null {
  if (typeof value === 'bigint') {
    const numberValue = Number(value);
    return Number.isSafeInteger(numberValue) ? numberValue : null;
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.floor(value));
}

export function tokenUsageInfoToSnapshot(
  info: TokenUsageInfo
): ConversationUsageSnapshot {
  return {
    totalTokens: info.total_tokens,
    contextWindow: info.model_context_window,
  };
}

export function agentUsageToTokenUsageInfo(
  usage: AgentUsage | AgentUsageLike
): TokenUsageInfo | null {
  const totalTokens = usageNumber(usage.used);

  if (totalTokens === null) {
    return null;
  }

  const limit = usageNumber(usage.limit);

  return {
    total_tokens: totalTokens,
    model_context_window: limit ?? totalTokens,
  };
}

export function agentUsageToSnapshot(
  usage: AgentUsage | AgentUsageLike
): ConversationUsageSnapshot | null {
  const tokenUsageInfo = agentUsageToTokenUsageInfo(usage);
  return tokenUsageInfo ? tokenUsageInfoToSnapshot(tokenUsageInfo) : null;
}

export function getLatestConversationTokenUsage(
  executionProcessState: ExecutionProcessStateStore
): TokenUsageInfo | null {
  const orderedProcesses = Object.values(executionProcessState).sort(
    (a, b) =>
      dateTimestamp(a.executionProcess.created_at) -
      dateTimestamp(b.executionProcess.created_at)
  );

  for (
    let processIndex = orderedProcesses.length - 1;
    processIndex >= 0;
    processIndex--
  ) {
    const process = orderedProcesses[processIndex];
    for (
      let entryIndex = process.entries.length - 1;
      entryIndex >= 0;
      entryIndex--
    ) {
      const entry = process.entries[entryIndex];
      if (
        entry.type === 'NORMALIZED_ENTRY' &&
        entry.content.entry_type.type === 'token_usage_info'
      ) {
        return entry.content.entry_type;
      }
    }
  }

  return null;
}

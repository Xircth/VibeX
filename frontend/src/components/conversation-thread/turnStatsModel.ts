import type {
  DisplayEntry,
  PatchTypeWithKey,
} from '@/hooks/useConversationHistory/types';
import { tokenUsageInfoToSnapshot } from '@/hooks/useConversationHistory/conversationTokenUsage';

export type TurnStatsData = {
  model?: string | null;
  startedAt?: string | null;
  totalTokens?: number | null;
  contextWindow?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  elapsedMs?: number | null;
  completedAt?: string | null;
  stopReason?: string | null;
};

export type TurnStatsByAssistantKey = Map<string, TurnStatsData>;

export type BuildTurnStatsOptions = {
  modelByExecutionProcessId?: Record<string, string | null | undefined>;
};

function isNormalizedEntry(
  entry: PatchTypeWithKey
): entry is PatchTypeWithKey & { type: 'NORMALIZED_ENTRY' } {
  return entry.type === 'NORMALIZED_ENTRY';
}

function entryTimestampMs(entry: PatchTypeWithKey): number | null {
  if (!isNormalizedEntry(entry) || !entry.content.timestamp) return null;

  const timestamp = Date.parse(entry.content.timestamp);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function setCompletedTime(
  stats: TurnStatsData,
  timestamp: string | null | undefined,
  userStartedAtMs: number | null
) {
  if (!timestamp) return;
  const completedAtMs = Date.parse(timestamp);
  if (!Number.isFinite(completedAtMs)) return;

  stats.completedAt = timestamp;
  if (userStartedAtMs !== null) {
    stats.elapsedMs = Math.max(0, completedAtMs - userStartedAtMs);
  }
}

function ensureStats(
  statsByKey: TurnStatsByAssistantKey,
  assistantKey: string
): TurnStatsData {
  const existing = statsByKey.get(assistantKey);
  if (existing) return existing;

  const stats: TurnStatsData = {};
  statsByKey.set(assistantKey, stats);
  return stats;
}

export function buildTurnStatsByAssistantKey(
  entries: PatchTypeWithKey[],
  options: BuildTurnStatsOptions = {}
): TurnStatsByAssistantKey {
  const statsByKey: TurnStatsByAssistantKey = new Map();
  let latestUserStartedAtMs: number | null = null;
  let latestUserStartedAt: string | null = null;
  let latestAssistantKey: string | null = null;

  for (const entry of entries) {
    if (!isNormalizedEntry(entry)) continue;

    const entryType = entry.content.entry_type;

    if (entryType.type === 'user_message') {
      latestUserStartedAtMs = entryTimestampMs(entry);
      latestUserStartedAt = entry.content.timestamp ?? null;
      latestAssistantKey = null;
      continue;
    }

    if (entryType.type === 'assistant_message') {
      latestAssistantKey = entry.patchKey;
      const stats = ensureStats(statsByKey, entry.patchKey);
      const model = options.modelByExecutionProcessId?.[entry.executionProcessId];

      stats.startedAt = latestUserStartedAt;

      if (model) {
        stats.model = model;
      }

      setCompletedTime(
        stats,
        entry.content.timestamp,
        latestUserStartedAtMs
      );
      continue;
    }

    if (entryType.type === 'token_usage_info' && latestAssistantKey) {
      const stats = ensureStats(statsByKey, latestAssistantKey);
      const usage = tokenUsageInfoToSnapshot(entryType);

      stats.totalTokens = usage.totalTokens;
      stats.contextWindow = usage.contextWindow;
      setCompletedTime(
        stats,
        entry.content.timestamp,
        latestUserStartedAtMs
      );
      continue;
    }

    if (entryType.type === 'system_message' && latestAssistantKey) {
      const turnCompletedMatch = entry.content.content.match(
        /^Turn completed(?::\s*(.+))?$/i
      );

      if (turnCompletedMatch) {
        const stats = ensureStats(statsByKey, latestAssistantKey);
        stats.stopReason = turnCompletedMatch[1]?.trim() || null;
        setCompletedTime(
          stats,
          entry.content.timestamp,
          latestUserStartedAtMs
        );
      }
    }
  }

  return statsByKey;
}

export function findLatestAssistantDisplayKey(
  displayEntries: DisplayEntry[]
): string | null {
  for (let index = displayEntries.length - 1; index >= 0; index -= 1) {
    const entry = displayEntries[index];
    if (
      entry?.type === 'NORMALIZED_ENTRY' &&
      entry.content.entry_type.type === 'assistant_message'
    ) {
      return entry.patchKey;
    }
  }

  return null;
}

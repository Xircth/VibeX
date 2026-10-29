import type {
  ProjectUsageSessionSummary,
  ProjectUsageSourcedTokens,
  ProjectUsageTokenCounts,
} from '@/lib/api';
import type { DimensionSubBreakdown, UsageRankingItem } from './types';
import { displayUsageLabel } from './usageFormat';
import { preferredTokenCounts, preferredTokenTotal } from './usageModel';

export function buildDimensionSubBreakdown(
  sessions: ProjectUsageSessionSummary[],
  fallbackTokens: ProjectUsageSourcedTokens,
  fallbackCost: number | null | undefined,
  fallbackSessionCount: number,
  notProvided: string,
  resolveProjectName: (
    folderPath: string | null | undefined,
    workspaceId: string
  ) => string
): DimensionSubBreakdown {
  const fallbackCounts = preferredTokenCounts(fallbackTokens);
  if (sessions.length === 0) {
    return {
      dailyAvgTokens: fallbackCounts?.total_tokens ?? null,
      activeDaysCount: fallbackCounts?.total_tokens ? 1 : 0,
      totalCost: fallbackCost ?? null,
      sessionCount: fallbackSessionCount,
      tokenCounts: fallbackCounts,
      topAgents: [],
      topModels: [],
      topFolders: [],
    };
  }

  let input = 0;
  let output = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  let total = 0;
  let hasTokens = false;
  let costSum = 0;
  let hasCost = false;
  const activeDaySet = new Set<string>();
  const agentMap = new Map<
    string,
    { label: string; cost: number | null; tokens: number | null; count: number }
  >();
  const modelMap = new Map<
    string,
    { label: string; cost: number | null; tokens: number | null; count: number }
  >();
  const folderMap = new Map<
    string,
    { label: string; cost: number | null; tokens: number | null; count: number }
  >();

  for (const session of sessions) {
    const counts = preferredTokenCounts(session.tokens);
    const sessionTotal = preferredTokenTotal(session.tokens);
    if (counts) {
      input += counts.input_tokens ?? 0;
      output += counts.output_tokens ?? 0;
      cacheWrite += counts.cache_write_tokens ?? 0;
      cacheRead += counts.cache_read_tokens ?? 0;
      total += sessionTotal ?? 0;
      hasTokens = true;
    }
    if (sessionTotal != null && sessionTotal > 0) {
      const date = new Date(session.timestamp);
      if (!Number.isNaN(date.getTime())) {
        activeDaySet.add(
          `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
        );
      }
    }
    if (session.cost != null) {
      costSum += session.cost;
      hasCost = true;
    }

    const agentKey = session.agent_id || 'unprovided';
    const agentEntry = agentMap.get(agentKey) ?? {
      label: displayUsageLabel(session.agent_id, notProvided),
      cost: null,
      tokens: null,
      count: 0,
    };
    agentEntry.count += 1;
    if (session.cost != null) {
      agentEntry.cost = (agentEntry.cost ?? 0) + session.cost;
    }
    if (sessionTotal != null) {
      agentEntry.tokens = (agentEntry.tokens ?? 0) + sessionTotal;
    }
    agentMap.set(agentKey, agentEntry);

    const modelKey = session.model || 'unprovided';
    const modelEntry = modelMap.get(modelKey) ?? {
      label: displayUsageLabel(session.model, notProvided),
      cost: null,
      tokens: null,
      count: 0,
    };
    modelEntry.count += 1;
    if (session.cost != null) {
      modelEntry.cost = (modelEntry.cost ?? 0) + session.cost;
    }
    if (sessionTotal != null) {
      modelEntry.tokens = (modelEntry.tokens ?? 0) + sessionTotal;
    }
    modelMap.set(modelKey, modelEntry);

    const folderKey = session.workspace_id;
    const folderEntry = folderMap.get(folderKey) ?? {
      label: resolveProjectName(session.folder, session.workspace_id),
      cost: null,
      tokens: null,
      count: 0,
    };
    folderEntry.count += 1;
    if (session.cost != null) {
      folderEntry.cost = (folderEntry.cost ?? 0) + session.cost;
    }
    if (sessionTotal != null) {
      folderEntry.tokens = (folderEntry.tokens ?? 0) + sessionTotal;
    }
    folderMap.set(folderKey, folderEntry);
  }

  const resolvedTokenCounts: ProjectUsageTokenCounts | null = hasTokens
    ? {
        input_tokens: input,
        output_tokens: output,
        cache_write_tokens: cacheWrite,
        cache_read_tokens: cacheRead,
        total_tokens: total,
      }
    : fallbackCounts;

  const activeDaysCount =
    activeDaySet.size || (resolvedTokenCounts?.total_tokens ? 1 : 0);
  const resolvedTotalTokens = resolvedTokenCounts?.total_tokens ?? null;
  const dailyAvgTokens =
    resolvedTotalTokens != null && activeDaysCount > 0
      ? resolvedTotalTokens / activeDaysCount
      : null;

  const toRankingList = (
    map: Map<
      string,
      {
        label: string;
        cost: number | null;
        tokens: number | null;
        count: number;
      }
    >
  ): UsageRankingItem[] =>
    Array.from(map.entries())
      .map(([id, item]) => ({
        id,
        label: item.label,
        cost: item.cost,
        totalTokens: item.tokens,
        sessionCount: item.count,
      }))
      .sort(
        (left, right) =>
          right.sessionCount - left.sessionCount ||
          (right.totalTokens ?? 0) - (left.totalTokens ?? 0)
      );

  return {
    dailyAvgTokens,
    activeDaysCount,
    totalCost: fallbackCost ?? (hasCost ? costSum : null),
    sessionCount: fallbackSessionCount || sessions.length,
    tokenCounts: resolvedTokenCounts,
    topAgents: toRankingList(agentMap),
    topModels: toRankingList(modelMap),
    topFolders: toRankingList(folderMap),
  };
}

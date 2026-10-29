import {
  localUsageApi,
  type ProjectUsageSessionSummary,
  type ProjectUsageStatistics,
} from '@/lib/api';
import {
  USAGE_STATS_GC_TIME_MS,
  USAGE_STATS_STALE_TIME_MS,
  type DateRange,
} from './types';
import {
  estimateUsageCost,
  isUnresolvedModelAlias,
  preferredTokenCounts,
} from './usageModel';

export function normalizeUsageStatistics(
  raw: ProjectUsageStatistics | null
): ProjectUsageStatistics | null {
  if (!raw) return null;

  const sessions = raw.sessions.map((session) => {
    const resolvedCost = isUnresolvedModelAlias(session.model)
      ? session.cost
      : (session.cost ??
        estimateUsageCost(session.model, preferredTokenCounts(session.tokens)));
    return resolvedCost === session.cost
      ? session
      : { ...session, cost: resolvedCost };
  });

  const sumSessionCosts = (
    predicate: (session: ProjectUsageSessionSummary) => boolean
  ): number | null => {
    let sum = 0;
    let found = false;
    for (const session of sessions) {
      if (predicate(session) && session.cost != null) {
        sum += session.cost;
        found = true;
      }
    }
    return found ? sum : null;
  };

  const by_model = raw.by_model
    .filter((modelItem) => !isUnresolvedModelAlias(modelItem.model))
    .map((modelItem) => {
      const resolvedCost =
        modelItem.cost ??
        estimateUsageCost(
          modelItem.model,
          preferredTokenCounts(modelItem.tokens)
        ) ??
        sumSessionCosts(
          (session) => (session.model ?? 'unprovided') === modelItem.model
        );
      return resolvedCost === modelItem.cost
        ? modelItem
        : { ...modelItem, cost: resolvedCost };
    })
    .sort((left, right) => (right.cost ?? -1) - (left.cost ?? -1));

  const by_folder = raw.by_folder.map((folderItem) => {
    const resolvedCost =
      folderItem.cost ??
      sumSessionCosts(
        (session) => session.workspace_id === folderItem.workspace_id
      );
    return resolvedCost === folderItem.cost
      ? folderItem
      : { ...folderItem, cost: resolvedCost };
  });

  const by_agent = raw.by_agent.map((agentItem) => {
    const resolvedCost =
      agentItem.cost ??
      sumSessionCosts(
        (session) => (session.agent_id ?? 'unprovided') === agentItem.agent_id
      ) ??
      (agentItem.agent_id.toLowerCase().includes('grok')
        ? estimateUsageCost('grok-4.6', preferredTokenCounts(agentItem.tokens))
        : null);
    return resolvedCost === agentItem.cost
      ? agentItem
      : { ...agentItem, cost: resolvedCost };
  });

  const daily_usage = raw.daily_usage.map((dayItem) => {
    if (dayItem.cost != null) return dayItem;
    const fallbackModel = dayItem.models_used?.[0] ?? null;
    const resolvedCost =
      estimateUsageCost(fallbackModel, preferredTokenCounts(dayItem.tokens)) ??
      null;
    return resolvedCost == null ? dayItem : { ...dayItem, cost: resolvedCost };
  });

  const estimated_cost =
    raw.estimated_cost ??
    sumSessionCosts(() => true) ??
    by_model.reduce<number | null>(
      (acc, item) => (item.cost != null ? (acc ?? 0) + item.cost : acc),
      null
    );

  return {
    ...raw,
    estimated_cost,
    sessions,
    daily_usage,
    by_model,
    by_folder,
    by_agent,
  };
}

export function getUsageTargetScope(target: string): 'global' | 'project' {
  return target === 'global' ? 'global' : 'project';
}

export function getUsageTargetProjectId(target: string): string | undefined {
  return target === 'global' ? undefined : target.replace(/^project:/, '');
}

export function getUsageStatisticsQueryOptions(
  target: string,
  dateRange: DateRange
) {
  return {
    queryKey: ['kanbanUsageStatistics', target, dateRange],
    queryFn: () =>
      localUsageApi.getProjectStatistics({
        scope: getUsageTargetScope(target),
        projectId: getUsageTargetProjectId(target),
        dateRange,
      }),
    placeholderData: (previousData: ProjectUsageStatistics | undefined) =>
      previousData,
    staleTime: USAGE_STATS_STALE_TIME_MS,
    gcTime: USAGE_STATS_GC_TIME_MS,
  };
}

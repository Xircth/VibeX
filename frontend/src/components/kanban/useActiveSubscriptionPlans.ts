import { useCallback, useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { AgentManagementView, AgentPlanUsage } from 'shared/types';
import { agentManagementApi } from '@/features/agent-management';
import {
  isPlanCapableAgentId,
  isSignedInSubscription,
} from './agentSubscriptionAuth';

export const PLAN_USAGE_STALE_TIME_MS = 180_000;

export type ActiveSubscriptionPlanItem = {
  agent: AgentManagementView;
  usage: AgentPlanUsage;
};

export function useActiveSubscriptionPlans(agents: AgentManagementView[]) {
  const candidatePlanAgents = useMemo(
    () =>
      agents.filter(
        (agent) =>
          agent.enabled &&
          agent.lifecycle !== 'uninstalled' &&
          !agent.retired &&
          agent.authentication === 'account' &&
          isPlanCapableAgentId(agent.agent_id)
      ),
    [agents]
  );

  const authQueries = useQueries({
    queries: candidatePlanAgents.map((agent) => ({
      queryKey: ['agent-auth-mode', agent.agent_id],
      queryFn: () => agentManagementApi.authMode(agent.agent_id),
      staleTime: PLAN_USAGE_STALE_TIME_MS,
      refetchOnWindowFocus: false,
    })),
  });

  const subscribedPlanAgents = useMemo(
    () =>
      candidatePlanAgents.filter((agent, index) =>
        isSignedInSubscription(agent, authQueries[index]?.data)
      ),
    [authQueries, candidatePlanAgents]
  );

  const planQueries = useQueries({
    queries: subscribedPlanAgents.map((agent) => ({
      queryKey: ['agent-plan-usage', agent.agent_id],
      queryFn: () => agentManagementApi.planUsage(agent.agent_id),
      staleTime: PLAN_USAGE_STALE_TIME_MS,
      refetchOnWindowFocus: false,
    })),
  });

  const activeSubscriptionPlans = useMemo(() => {
    const items: ActiveSubscriptionPlanItem[] = [];
    subscribedPlanAgents.forEach((agent, index) => {
      const result = planQueries[index]?.data;
      if (
        result?.type === 'OK' &&
        (result.usage.windows.length > 0 || result.usage.credits != null)
      ) {
        items.push({ agent, usage: result.usage });
      }
    });
    return items;
  }, [planQueries, subscribedPlanAgents]);

  const planUsagesByAgentId = useMemo(() => {
    const record: Partial<Record<string, AgentPlanUsage>> = {};
    for (const { agent, usage } of activeSubscriptionPlans) {
      record[agent.agent_id] = usage;
    }
    return record;
  }, [activeSubscriptionPlans]);

  const refreshStale = useCallback(() => {
    for (const query of authQueries) {
      if (query.isStale && !query.isFetching) {
        void query.refetch();
      }
    }
    for (const query of planQueries) {
      if (query.isStale && !query.isFetching) {
        void query.refetch();
      }
    }
  }, [authQueries, planQueries]);

  return {
    activeSubscriptionPlans,
    planUsagesByAgentId,
    refreshStale,
  };
}

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { BaseCodingAgent } from 'shared/types';
import { agentSettingsApi } from '@/lib/api';
import { agentsApi } from './api';
import { baseCodingAgentFromAgentType } from './agentTypeMapping';

export type SelectableAgent = {
  agent: BaseCodingAgent;
  /** The user has not disabled this agent in settings. */
  enabled: boolean;
  /** A local binary/runtime was detected for this agent. */
  installed: boolean;
};

/**
 * Agents the user can pick for a session, sourced from the ACP agent registry
 * (the runtime that actually executes sessions) joined with per-agent settings
 * for enabled/installed state.
 *
 * Disabled agents are still returned so callers can decide how to present them;
 * the picker hides disabled ones and greys out enabled-but-not-installed ones
 * with an install affordance.
 */
export function useSelectableAgents(): SelectableAgent[] {
  const { data: registry } = useQuery({
    queryKey: ['agent-registry'],
    queryFn: agentsApi.listRegistry,
    staleTime: 5 * 60 * 1000,
  });
  const { data: settings } = useQuery({
    queryKey: ['agent-settings'],
    queryFn: agentSettingsApi.list,
    staleTime: 60 * 1000,
  });

  return useMemo(() => {
    if (!registry) return [];
    const settingByType = new Map(
      (settings ?? []).map((setting) => [setting.agent_type, setting])
    );
    const seen = new Set<BaseCodingAgent>();
    const result: SelectableAgent[] = [];
    for (const entry of registry) {
      const agent = baseCodingAgentFromAgentType(entry.agent_type);
      if (!agent || seen.has(agent)) continue;
      seen.add(agent);
      const setting = settingByType.get(entry.agent_type);
      result.push({
        agent,
        enabled: setting?.enabled ?? true,
        installed:
          entry.distribution.kind === 'npx' ||
          (setting ? setting.installed_version != null : false),
      });
    }
    return result;
  }, [registry, settings]);
}

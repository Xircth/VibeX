import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AgentKind } from 'shared/types';
import { agentSettingsApi } from '@/lib/api';
import { agentsApi } from './api';
import { baseCodingAgentFromAgentType } from './agentTypeMapping';

export type SelectableAgent = {
  agent: AgentKind;
  /** The user has not disabled this agent in settings. */
  enabled: boolean;
  /**
   * Backend-verified local presence (login/config marker, PATH binary, or
   * global npm package). Never inferred from the distribution kind.
   */
  installed: boolean;
  /** Runtime prerequisites (node/uv) are satisfied, so installing can work. */
  runtimeOk: boolean;
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

  const selectableAgents = useMemo(() => {
    if (!registry) return [];
    const settingByType = new Map(
      (settings ?? []).map((setting) => [setting.agent_type, setting])
    );
    const seen = new Set<AgentKind>();
    const result: SelectableAgent[] = [];
    for (const entry of registry) {
      const agent = baseCodingAgentFromAgentType(entry.agent_type);
      if (!agent || seen.has(agent)) continue;
      seen.add(agent);
      const setting = settingByType.get(entry.agent_type);
      result.push({
        agent,
        enabled: setting?.enabled ?? true,
        installed: setting?.installed ?? false,
        runtimeOk: setting?.runtime_ok ?? false,
      });
    }
    return result;
  }, [registry, settings]);

  // Catalog warming is deliberately owned by the application-startup and
  // explicit runtime/config lifecycle paths. Starting it here would make
  // opening an Agent selector silently spawn ACP on demand again.
  return selectableAgents;
}

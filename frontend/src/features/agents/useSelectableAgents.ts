import { useEffect, useState } from 'react';
import type {
  AgentId,
  AgentLifecycleState,
  AgentManagementView,
} from 'shared/types';

import { agentManagementApi } from '@/features/agent-management';

export type SelectableAgent = {
  agentId: AgentId;
  displayName: string;
  iconLight: string | null;
  iconDark: string | null;
  iconSvg: string | null;
  enabled: boolean;
  lifecycle: AgentLifecycleState;
  runnable: boolean;
};

function toSelectableAgent(agent: AgentManagementView): SelectableAgent {
  return {
    agentId: agent.agent_id,
    displayName: agent.display_name,
    iconLight: agent.icon_light,
    iconDark: agent.icon_dark,
    iconSvg: agent.icon_svg,
    enabled: agent.enabled,
    lifecycle: agent.lifecycle,
    runnable:
      agent.enabled &&
      agent.lifecycle === 'ready' &&
      agent.active_operation === null,
  };
}

/**
 * The management projection is the sole source for session eligibility.
 * It already joins membership, enabled state, verified local Runtime, ACP
 * handshake and active operations, so selectors must not reconstruct those
 * decisions from the public Registry or a closed built-in list.
 */
export function useSelectableAgents(): SelectableAgent[] {
  const [agents, setAgents] = useState<SelectableAgent[]>([]);

  useEffect(() => {
    let active = true;
    void agentManagementApi
      .bar()
      .then((rows) => {
        if (active) setAgents(rows.map(toSelectableAgent));
      })
      .catch(() => {
        if (active) setAgents([]);
      });
    return () => {
      active = false;
    };
  }, []);

  return agents;
}

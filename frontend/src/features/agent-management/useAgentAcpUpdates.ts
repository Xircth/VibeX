import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentManagementView } from 'shared/types';

import {
  invalidateAgentAcpUpdate,
  readCachedAgentAcpUpdates,
  refreshAgentAcpUpdates,
  subscribeAgentAcpUpdates,
} from './agentAcpUpdates';
import { isAgentAcpUpdateCheckable } from './agentVersion';

function toUpdatableIds(
  available: Record<string, boolean>,
  agents: AgentManagementView[]
): Set<string> {
  const checkable = new Set(
    agents.filter(isAgentAcpUpdateCheckable).map((agent) => agent.agent_id)
  );
  return new Set(
    Object.entries(available)
      .filter(([agentId, isAvailable]) => isAvailable && checkable.has(agentId))
      .map(([agentId]) => agentId)
  );
}

function checkSignature(agents: AgentManagementView[]): string {
  return agents
    .filter(isAgentAcpUpdateCheckable)
    .map((agent) => `${agent.agent_id}:${agent.acp_version ?? ''}`)
    .join('|');
}

export function useAgentAcpUpdates(
  agents: AgentManagementView[]
): ReadonlySet<string> {
  const [available, setAvailable] = useState(readCachedAgentAcpUpdates);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const signature = checkSignature(agents);

  useEffect(() => subscribeAgentAcpUpdates(setAvailable), []);

  useEffect(() => {
    for (const agent of agents) {
      if (
        agent.lifecycle === 'updating' ||
        agent.active_operation === 'update'
      ) {
        invalidateAgentAcpUpdate(agent.agent_id);
      }
    }
  }, [agents]);

  useEffect(() => {
    if (!signature) {
      setAvailable({});
      return;
    }
    let active = true;
    void refreshAgentAcpUpdates(agentsRef.current)
      .then((next) => {
        if (active) setAvailable(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [signature]);

  return useMemo(() => toUpdatableIds(available, agents), [available, agents]);
}

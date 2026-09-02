export function moveAgentInOrder(
  agentIds: string[],
  activeId: string,
  overId: string
): string[] | null {
  const from = agentIds.indexOf(activeId);
  const to = agentIds.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  const next = agentIds.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function nudgeAgentInOrder(
  agentIds: string[],
  agentId: string,
  direction: -1 | 1
): string[] | null {
  const from = agentIds.indexOf(agentId);
  if (from < 0) return null;
  const to = from + direction;
  if (to < 0 || to >= agentIds.length) return null;
  return moveAgentInOrder(agentIds, agentId, agentIds[to]);
}

export function sortAgentsForBar<
  T extends { agent_id: string; enabled: boolean },
>(agents: T[], defaultAgentId: string | null): T[] {
  if (agents.length === 0) return [];
  const defaultId =
    defaultAgentId && agents.some((agent) => agent.agent_id === defaultAgentId)
      ? defaultAgentId
      : (agents.find((agent) => agent.enabled)?.agent_id ??
        agents[0]?.agent_id ??
        null);
  const head = agents.filter((agent) => agent.agent_id === defaultId);
  const enabled = agents.filter(
    (agent) => agent.enabled && agent.agent_id !== defaultId
  );
  const disabled = agents.filter(
    (agent) => !agent.enabled && agent.agent_id !== defaultId
  );
  return [...head, ...enabled, ...disabled];
}

export function defaultAgentIdFromOrder(
  order: string[],
  currentDefaultId: string | null
): string | null {
  return order[0] ?? currentDefaultId;
}

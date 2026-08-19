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

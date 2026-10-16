import type { CSSProperties } from 'react';

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

export const AGENT_BAR_LAYOUT = {
  itemSize: 32,
  /** Minimum space between two Agent icons. */
  itemGap: 11,
  pagePadding: 0,
  pagerWidth: 20,
  maxPerPage: 10,
  labelMaxWidth: 128,
  labelInset: 10,
} as const;

export const agentBarLayoutStyle = {
  '--agent-bar-item-size': `${AGENT_BAR_LAYOUT.itemSize}px`,
  '--agent-bar-item-gap': `${AGENT_BAR_LAYOUT.itemGap}px`,
  '--agent-bar-page-padding': `${AGENT_BAR_LAYOUT.pagePadding}px`,
  '--agent-bar-pager-width': `${AGENT_BAR_LAYOUT.pagerWidth}px`,
  '--agent-bar-label-max': `${AGENT_BAR_LAYOUT.labelMaxWidth}px`,
} as CSSProperties;

export type AgentBarPaging = {
  /** Width of the icon region, which excludes the fixed tail controls. */
  viewportWidth: number;
  /** The Agent whose name is shown beside its icon, if any. */
  expandedId: string | null;
  /** Natural width of the expanded name. */
  labelWidth: number;
};

function agentWidth(
  agentId: string,
  { expandedId, labelWidth }: AgentBarPaging
): number {
  const { itemSize, labelMaxWidth, labelInset } = AGENT_BAR_LAYOUT;
  return agentId === expandedId
    ? itemSize + Math.min(labelWidth, labelMaxWidth) + labelInset
    : itemSize;
}

/** Width of the icons and the gaps between them, with no trailing tail gap. */
export function agentBarContentWidth(
  agentIds: string[],
  paging: Pick<AgentBarPaging, 'expandedId' | 'labelWidth'>
): number {
  if (agentIds.length === 0) return 0;
  let used = 0;
  for (const id of agentIds) {
    used += agentWidth(id, { viewportWidth: 0, ...paging });
  }
  const gaps = Math.max(agentIds.length - 1, 0) * AGENT_BAR_LAYOUT.itemGap;
  return used + gaps;
}

/**
 * Computes the uniform gap for a page so that the tail component at the end
 * participates in the width allocation. With `count` icons on the page, there
 * are `count` gaps (including the trailing gap between the last icon and the
 * tail).
 */
export function agentBarPageGap(
  agentIds: string[],
  paging: AgentBarPaging,
  maxGap?: number
): number {
  if (paging.viewportWidth <= 0 || agentIds.length === 0) {
    return AGENT_BAR_LAYOUT.itemGap;
  }
  const count = agentIds.length;
  let usedWidth = 0;
  for (const id of agentIds) {
    usedWidth += agentWidth(id, paging);
  }
  const freeSpace = paging.viewportWidth - usedWidth;
  const computed = Math.floor(freeSpace / count);
  const minGap = AGENT_BAR_LAYOUT.itemGap;
  const gap = Math.max(minGap, computed);
  return maxGap !== undefined ? Math.min(gap, maxGap) : gap;
}

/**
 * Packs Agents into pages of at most `maxPerPage`, as many as fit at the
 * minimum gap; each icon pays for its width plus 1 minimum gap, which leaves
 * at least 1 minimum gap between the last icon and the tail.
 */
export function agentBarPages(
  agentIds: string[],
  paging: AgentBarPaging
): string[][] {
  if (paging.viewportWidth <= 0 || agentIds.length === 0) return [agentIds];
  const { itemGap, maxPerPage, pagePadding } = AGENT_BAR_LAYOUT;
  const room = paging.viewportWidth - pagePadding * 2;
  const pages: string[][] = [];
  let start = 0;
  while (start < agentIds.length) {
    let used = 0;
    let end = start;
    while (end < agentIds.length && end - start < maxPerPage) {
      const next = used + agentWidth(agentIds[end], paging) + itemGap;
      if (next > room && end > start) break;
      used = next;
      end += 1;
    }
    pages.push(agentIds.slice(start, end));
    start = end;
  }
  return pages;
}

export function agentBarPageOf(
  pages: string[][],
  agentId: string
): number | null {
  const index = pages.findIndex((page) => page.includes(agentId));
  return index < 0 ? null : index;
}

/**
 * Re-seats a dragged Agent on the page the user just flipped to. `targetPage`
 * is that page packed without the dragged Agent: it enters before the first
 * item when arriving from the left, and before the last item when arriving
 * from the right, so it takes the edge slot on the side it came from. A page
 * that no longer exists receives it at the very end.
 */
export function moveAgentToPageEdge(
  agentIds: string[],
  agentId: string,
  targetPage: string[] | undefined,
  edge: 'start' | 'end'
): string[] | null {
  if (!agentIds.includes(agentId)) return null;
  const rest = agentIds.filter((id) => id !== agentId);
  const anchor =
    edge === 'start' ? targetPage?.[0] : targetPage?.[targetPage.length - 1];
  const to = anchor === undefined ? rest.length : rest.indexOf(anchor);
  rest.splice(to, 0, agentId);
  return rest.every((id, index) => id === agentIds[index]) ? null : rest;
}

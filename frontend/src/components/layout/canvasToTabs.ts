import {
  isPanelCanvasNode,
  type SessionCanvasNode,
} from '@/components/kanban/canvas/canvasModel';

/** Cap free-tab restoration so a large canvas does not open an unbounded tab set. */
export const MAX_CANVAS_TABS_FROM_STAGE = 10;

export interface CanvasSessionTabMeta {
  workspaceId: string;
  updatedAt: number;
  title: string | null;
  agentId: string | null;
}

export type CanvasTabOpenRequest =
  | {
      kind: 'session';
      sessionId: string;
      workspaceId: string;
      title: string | null;
      agentId: string | null;
      activate: boolean;
    }
  | {
      kind: 'panel';
      panelId: string;
      title: string;
      component: string;
      params: Record<string, unknown>;
      activate: boolean;
    };

interface RankedCanvasNode {
  node: SessionCanvasNode;
  primary: number;
  secondary: number;
}

function nodeActivity(
  node: SessionCanvasNode,
  sessionUpdatedAt: number,
  now: number
): { primary: number; secondary: number } | null {
  if (node.kind === 'group') return null;
  const panel = isPanelCanvasNode(node);
  const session = !panel && node.sessionId.length > 0;
  if (!panel && !session) return null;
  const secondary = Math.max(
    session ? sessionUpdatedAt : 0,
    node.createdAt || 0
  );
  const primary = node.expanded ? Math.max(now, secondary) : secondary;
  return { primary, secondary };
}

function nodeKey(node: SessionCanvasNode): string | null {
  if (isPanelCanvasNode(node)) {
    const panelId = node.panelId ?? node.id;
    return panelId ? `panel:${panelId}` : null;
  }
  return node.sessionId ? `session:${node.sessionId}` : null;
}

function compareRanked(
  left: RankedCanvasNode,
  right: RankedCanvasNode
): number {
  if (left.primary !== right.primary) return right.primary - left.primary;
  if (left.secondary !== right.secondary)
    return right.secondary - left.secondary;
  return (right.node.createdAt || 0) - (left.node.createdAt || 0);
}

function toRequest(
  node: SessionCanvasNode,
  meta: CanvasSessionTabMeta | undefined,
  activate: boolean
): CanvasTabOpenRequest | null {
  if (isPanelCanvasNode(node)) {
    const component = node.panelComponent ?? '';
    const panelId = node.panelId ?? node.id;
    if (!component || !panelId) return null;
    return {
      kind: 'panel',
      panelId,
      title: node.panelTitle?.trim() || component,
      component,
      params: {
        ...(node.panelParams ?? {}),
        __component: component,
      },
      activate,
    };
  }
  if (!node.sessionId || !meta?.workspaceId) return null;
  return {
    kind: 'session',
    sessionId: node.sessionId,
    workspaceId: meta.workspaceId,
    title: meta.title,
    agentId: meta.agentId,
    activate,
  };
}

/**
 * Pick the most recently active canvas nodes and return them oldest-first.
 * The last request is the one that should become the active tab.
 * Expanded windows outrank collapsed cards. Sessions use their update time.
 */
export function planCanvasTabsFromNodes(
  nodes: readonly SessionCanvasNode[],
  sessions: ReadonlyMap<string, CanvasSessionTabMeta>,
  options?: { limit?: number; now?: number }
): CanvasTabOpenRequest[] {
  const now = options?.now ?? 0;
  const limit = options?.limit ?? MAX_CANVAS_TABS_FROM_STAGE;
  const best = new Map<string, RankedCanvasNode>();

  for (const node of nodes) {
    const key = nodeKey(node);
    if (!key) continue;
    const meta = sessions.get(node.sessionId);
    const activity = nodeActivity(node, meta?.updatedAt ?? 0, now);
    if (!activity) continue;
    const ranked: RankedCanvasNode = { node, ...activity };
    const existing = best.get(key);
    if (!existing || compareRanked(ranked, existing) < 0) {
      best.set(key, ranked);
    }
  }

  const openable: CanvasTabOpenRequest[] = [];
  for (const item of [...best.values()].sort(compareRanked)) {
    const request = toRequest(
      item.node,
      sessions.get(item.node.sessionId),
      false
    );
    if (!request) continue;
    openable.push(request);
    if (openable.length >= limit) break;
  }
  openable.reverse();
  if (openable.length > 0) {
    const last = openable.length - 1;
    openable[last] = { ...openable[last], activate: true };
  }
  return openable;
}

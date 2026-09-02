import { dateTimestamp } from '@/utils/date';

/**
 * Pure geometry and import helpers for the kanban infinite canvas. Board
 * units are the canvas coordinate system — they must not follow the app
 * appearance zoom (root font-size), matching Codeg's canvas-model contract.
 */

export const CARD_WIDTH = 196;
export const CARD_HEIGHT = 72;

export const DETAIL_CARD_WIDTH = 364;
export const DETAIL_CARD_HEIGHT = 627;
export const DETAIL_MIN_WIDTH = 360;
export const DETAIL_MIN_HEIGHT = 320;

export const BOARD_DOT_GAP = 24;
export const CARD_GAP = 24;
export const PACK_ROW_WIDTH = 2400;

export const DRAG_HANDLE_CLASS = 'canvas-card-drag-handle';
export const DRAG_HANDLE_SELECTOR = `.${DRAG_HANDLE_CLASS}`;

export const CANVAS_MIN_ZOOM = 0.1;
export const CANVAS_MAX_ZOOM = 2;

export const RECENT_SESSION_DAY_OPTIONS = [1, 3, 7, 14, 30] as const;
export type RecentSessionDays = (typeof RECENT_SESSION_DAY_OPTIONS)[number];
export const DEFAULT_RECENT_SESSION_DAYS: RecentSessionDays = 7;

export const ARCHIVED_STATUS = 'archived';

export type CanvasNodeKind = 'session' | 'group';

export interface SessionCanvasNode {
  id: string;
  kind: CanvasNodeKind;
  sessionId: string;
  parentId: string | null;
  name: string;
  createdAt: number;
  showAll: boolean;
  collapsed?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  expanded: boolean;
}

export interface CanvasRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export interface AlignmentGuide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

export interface AlignmentResult {
  dx: number;
  dy: number;
  guides: AlignmentGuide[];
}

export interface SessionCanvasMove {
  id: string;
  x: number;
  y: number;
}

export interface RecentSessionLike {
  id: string;
  updatedAt: string;
  status?: string;
}

const NO_ALIGNMENT: AlignmentResult = { dx: 0, dy: 0, guides: [] };

export function canvasNodeId(instanceId: string): string {
  return `session-${instanceId}`;
}

export function parseCanvasNodeId(id: string): string | null {
  if (!id.startsWith('session-')) return null;
  const instanceId = id.slice('session-'.length);
  return instanceId.length > 0 ? instanceId : null;
}

export function createCanvasInstanceId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createCanvasNode(
  sessionId: string,
  position: { x: number; y: number },
  id = createCanvasInstanceId()
): SessionCanvasNode {
  return {
    id,
    kind: 'session',
    sessionId,
    parentId: null,
    name: '',
    createdAt: Date.now(),
    showAll: false,
    x: position.x,
    y: position.y,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    expanded: false,
  };
}

export function sameSessionLinks(
  nodes: readonly SessionCanvasNode[]
): Array<{ id: string; source: string; target: string }> {
  const groups = new Map<string, SessionCanvasNode[]>();
  for (const node of nodes) {
    if (!node.sessionId) continue;
    const group = groups.get(node.sessionId);
    if (group) group.push(node);
    else groups.set(node.sessionId, [node]);
  }

  const links: Array<{ id: string; source: string; target: string }> = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const from = sorted[i];
        const to = sorted[j];
        if (!from || !to) continue;
        links.push({
          id: `same-${from.id}-${to.id}`,
          source: canvasNodeId(from.id),
          target: canvasNodeId(to.id),
        });
      }
    }
  }
  return links;
}

export function sizeForNode(node: SessionCanvasNode): CanvasSize {
  if (node.kind === 'group') {
    return { width: node.width, height: node.height };
  }
  if (node.expanded) {
    return {
      width: Math.max(node.width, DETAIL_MIN_WIDTH),
      height: Math.max(node.height, DETAIL_MIN_HEIGHT),
    };
  }
  return { width: CARD_WIDTH, height: CARD_HEIGHT };
}

export function defaultExpandedSize(): CanvasSize {
  return { width: DETAIL_CARD_WIDTH, height: DETAIL_CARD_HEIGHT };
}

export interface CanvasNodeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function expandNode(node: SessionCanvasNode): SessionCanvasNode {
  if (node.expanded) return node;
  const size = defaultExpandedSize();
  return {
    ...node,
    expanded: true,
    width: size.width,
    height: size.height,
  };
}

export function collapseNode(node: SessionCanvasNode): SessionCanvasNode {
  if (!node.expanded) return node;
  return {
    ...node,
    expanded: false,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
  };
}

export function resizeNode(
  node: SessionCanvasNode,
  geometry: CanvasNodeGeometry
): SessionCanvasNode {
  if (!node.expanded) return node;
  return {
    ...node,
    x: geometry.x,
    y: geometry.y,
    width: Math.max(geometry.width, DETAIL_MIN_WIDTH),
    height: Math.max(geometry.height, DETAIL_MIN_HEIGHT),
  };
}

export function resetNodeSize(node: SessionCanvasNode): SessionCanvasNode {
  if (!node.expanded) return node;
  const size = defaultExpandedSize();
  return {
    ...node,
    width: size.width,
    height: size.height,
  };
}

function edgesX(rect: CanvasRect): number[] {
  return [rect.x, rect.x + rect.width / 2, rect.x + rect.width];
}

function edgesY(rect: CanvasRect): number[] {
  return [rect.y, rect.y + rect.height / 2, rect.y + rect.height];
}

function snapToLattice(value: number, gap: number, tolerance: number): number {
  if (!(tolerance > 0)) return 0;
  const delta = Math.round(value / gap) * gap - value;
  return Math.abs(delta) <= tolerance ? delta : 0;
}

/**
 * Snap a moving rect to neighbouring edges (and, as a fallback, the board
 * dot lattice). `tolerance` is in flow units — callers should divide a
 * screen-pixel distance by the current zoom.
 */
export function computeAlignment(
  moving: CanvasRect,
  others: readonly CanvasRect[],
  tolerance: number,
  gridGap?: number
): AlignmentResult {
  if (!(tolerance > 0)) return NO_ALIGNMENT;
  if (others.length === 0 && !(gridGap && gridGap > 0)) return NO_ALIGNMENT;

  let bestX: { delta: number; at: number; other: CanvasRect } | null = null;
  let bestY: { delta: number; at: number; other: CanvasRect } | null = null;

  for (const other of others) {
    for (const from of edgesX(moving)) {
      for (const to of edgesX(other)) {
        const delta = to - from;
        if (Math.abs(delta) > tolerance) continue;
        if (!bestX || Math.abs(delta) < Math.abs(bestX.delta)) {
          bestX = { delta, at: to, other };
        }
      }
    }
    for (const from of edgesY(moving)) {
      for (const to of edgesY(other)) {
        const delta = to - from;
        if (Math.abs(delta) > tolerance) continue;
        if (!bestY || Math.abs(delta) < Math.abs(bestY.delta)) {
          bestY = { delta, at: to, other };
        }
      }
    }
  }

  const gridDx =
    gridGap && gridGap > 0 && !bestX
      ? snapToLattice(moving.x, gridGap, Math.min(tolerance, gridGap / 4))
      : 0;
  const gridDy =
    gridGap && gridGap > 0 && !bestY
      ? snapToLattice(moving.y, gridGap, Math.min(tolerance, gridGap / 4))
      : 0;

  const dx = bestX?.delta ?? gridDx;
  const dy = bestY?.delta ?? gridDy;

  const snapped: CanvasRect = { ...moving, x: moving.x + dx, y: moving.y + dy };
  const guides: AlignmentGuide[] = [];
  if (bestX) {
    guides.push({
      axis: 'x',
      at: bestX.at,
      from: Math.min(snapped.y, bestX.other.y),
      to: Math.max(
        snapped.y + snapped.height,
        bestX.other.y + bestX.other.height
      ),
    });
  }
  if (bestY) {
    guides.push({
      axis: 'y',
      at: bestY.at,
      from: Math.min(snapped.x, bestY.other.x),
      to: Math.max(
        snapped.x + snapped.width,
        bestY.other.x + bestY.other.width
      ),
    });
  }
  return { dx, dy, guides };
}

export function packLayout(
  nodes: readonly SessionCanvasNode[],
  opts: { gap?: number; rowWidth?: number } = {}
): SessionCanvasMove[] {
  const gap = opts.gap ?? CARD_GAP * 2;
  const rowWidth = opts.rowWidth ?? PACK_ROW_WIDTH;
  const sorted = nodes
    .filter((node) => !node.parentId || node.expanded)
    .sort((a, b) => {
      const ha = sizeForNode(a).height;
      const hb = sizeForNode(b).height;
      if (ha !== hb) return hb - ha;
      return a.id.localeCompare(b.id);
    });

  const moves: SessionCanvasMove[] = [];
  let shelfX = 0;
  let shelfY = 0;
  let shelfHeight = 0;
  for (const node of sorted) {
    const { width, height } = sizeForNode(node);
    if (shelfX > 0 && shelfX + width > rowWidth) {
      shelfY += shelfHeight + gap;
      shelfX = 0;
      shelfHeight = 0;
    }
    if (node.x !== shelfX || node.y !== shelfY) {
      moves.push({ id: node.id, x: shelfX, y: shelfY });
    }
    shelfX += width + gap;
    shelfHeight = Math.max(shelfHeight, height);
  }
  return moves;
}

export function applyMoves(
  nodes: readonly SessionCanvasNode[],
  moves: readonly SessionCanvasMove[]
): SessionCanvasNode[] {
  if (moves.length === 0) return [...nodes];
  const byId = new Map(moves.map((move) => [move.id, move]));
  return nodes.map((node) => {
    const move = byId.get(node.id);
    return move ? { ...node, x: move.x, y: move.y } : node;
  });
}

export function filterRecentSessions<T extends RecentSessionLike>(
  sessions: readonly T[],
  days: number,
  now = Date.now()
): T[] {
  const windowMs = Math.max(0, days) * 24 * 60 * 60 * 1000;
  const cutoff = now - windowMs;
  return sessions
    .filter((session) => {
      if (session.status === ARCHIVED_STATUS) return false;
      const updated = dateTimestamp(session.updatedAt);
      return Number.isFinite(updated) && updated >= cutoff;
    })
    .sort((a, b) => dateTimestamp(b.updatedAt) - dateTimestamp(a.updatedAt));
}

export function layoutImportedSessions(
  sessionIds: readonly string[],
  existing: readonly SessionCanvasNode[],
  origin: { x: number; y: number } = { x: 0, y: 0 }
): SessionCanvasNode[] {
  const present = new Set(existing.map((node) => node.sessionId));
  const incoming = sessionIds.filter((id) => !present.has(id));
  if (incoming.length === 0) return [];

  const gap = CARD_GAP;
  const perRow = 4;
  return incoming.map((sessionId, index) => {
    const col = index % perRow;
    const row = Math.floor(index / perRow);
    return createCanvasNode(sessionId, {
      x: origin.x + col * (CARD_WIDTH + gap),
      y: origin.y + row * (CARD_HEIGHT + gap),
    });
  });
}

export function nextDropPoint(existing: readonly SessionCanvasNode[]): {
  x: number;
  y: number;
} {
  if (existing.length === 0) return { x: 0, y: 0 };
  const maxRight = Math.max(
    ...existing.map((node) => node.x + sizeForNode(node).width)
  );
  const minY = Math.min(...existing.map((node) => node.y));
  return { x: maxRight + CARD_GAP, y: minY };
}

export function pruneMissingSessions(
  nodes: readonly SessionCanvasNode[],
  liveIds: ReadonlySet<string>
): SessionCanvasNode[] {
  return nodes.filter(
    (node) => node.kind === 'group' || liveIds.has(node.sessionId)
  );
}

export function upsertCanvasNode(
  nodes: readonly SessionCanvasNode[],
  next: SessionCanvasNode
): SessionCanvasNode[] {
  const index = nodes.findIndex((node) => node.id === next.id);
  if (index === -1) return [...nodes, next];
  const copy = [...nodes];
  copy[index] = next;
  return copy;
}

export function removeCanvasNode(
  nodes: readonly SessionCanvasNode[],
  instanceId: string
): SessionCanvasNode[] {
  return nodes.filter((node) => node.id !== instanceId);
}

export function nodeToRect(node: SessionCanvasNode): CanvasRect {
  const size = sizeForNode(node);
  return {
    id: node.id,
    x: node.x,
    y: node.y,
    width: size.width,
    height: size.height,
  };
}

export interface ReusableFlowNode {
  id: string;
  type?: string;
  selected?: boolean;
  dragHandle?: string;
  parentId?: string;
  hidden?: boolean;
  className?: string;
  zIndex?: number;
  width?: number;
  height?: number;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export function reuseUnchangedFlowNode<T extends ReusableFlowNode>(
  previous: T | undefined,
  next: T
): T {
  if (
    previous &&
    previous.type === next.type &&
    previous.selected === next.selected &&
    previous.dragHandle === next.dragHandle &&
    previous.parentId === next.parentId &&
    previous.hidden === next.hidden &&
    previous.className === next.className &&
    previous.zIndex === next.zIndex &&
    previous.width === next.width &&
    previous.height === next.height &&
    previous.position.x === next.position.x &&
    previous.position.y === next.position.y &&
    previous.data.sessionId === next.data.sessionId
  ) {
    return previous;
  }
  if (!previous) return next;
  return {
    ...next,
    data:
      previous.data.sessionId === next.data.sessionId
        ? previous.data
        : next.data,
  };
}

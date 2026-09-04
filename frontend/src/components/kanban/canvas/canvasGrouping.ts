import {
  CARD_GAP,
  CARD_HEIGHT,
  CARD_WIDTH,
  DETAIL_CARD_HEIGHT,
  DETAIL_CARD_WIDTH,
  collapseNode,
  expandNode,
  createCanvasInstanceId,
  createCanvasNode,
  parseCanvasNodeId,
  sizeForNode,
  type SessionCanvasNode,
} from './canvasModel';

export const GROUP_HEADER_HEIGHT = 32;
export const GROUP_FOOTER_HEIGHT = 32;
export const GROUP_PAD = 12;
export const GROUP_GAP = 12;
export const GROUP_COLLAPSED_HEIGHT = GROUP_HEADER_HEIGHT;
export const DEFAULT_GROUP_COLUMNS = 2;
export const EMPTY_GROUP_COLUMNS = DEFAULT_GROUP_COLUMNS;
export const EMPTY_GROUP_ROWS = 2;
export const MAX_GROUP_COLUMNS = 10;
export const MAX_GROUP_ROWS = 20;
export const MAX_GROUP_DEPTH = 2;

export function groupWidthForColumns(columns: number): number {
  const count = Math.max(1, Math.round(columns));
  return GROUP_PAD * 2 + count * CARD_WIDTH + (count - 1) * GROUP_GAP;
}

export function groupHeightForRows(rows: number, overflow = false): number {
  const count = Math.max(1, Math.round(rows));
  return (
    GROUP_HEADER_HEIGHT +
    GROUP_PAD * 2 +
    count * CARD_HEIGHT +
    (count - 1) * GROUP_GAP +
    (overflow ? GROUP_FOOTER_HEIGHT : 0)
  );
}

export function columnsForGroupWidth(width: number): number {
  const usable = Math.max(width - GROUP_PAD * 2, CARD_WIDTH);
  return Math.max(
    1,
    Math.floor((usable + GROUP_GAP) / (CARD_WIDTH + GROUP_GAP))
  );
}

export function rowsForGroupHeight(height: number): number {
  const usable = Math.max(
    height - GROUP_HEADER_HEIGHT - GROUP_PAD * 2,
    CARD_HEIGHT
  );
  return Math.max(
    1,
    Math.floor((usable + GROUP_GAP) / (CARD_HEIGHT + GROUP_GAP))
  );
}

export function worldPosition(
  nodes: readonly SessionCanvasNode[],
  node: SessionCanvasNode
): { x: number; y: number } {
  if (!node.parentId || node.expanded) return { x: node.x, y: node.y };
  const parent = nodeById(nodes, node.parentId);
  if (!parent) return { x: node.x, y: node.y };
  const origin = worldPosition(nodes, parent);
  return { x: origin.x + node.x, y: origin.y + node.y };
}

export function worldRect(
  nodes: readonly SessionCanvasNode[],
  node: SessionCanvasNode
): { x: number; y: number; width: number; height: number; id: string } {
  const size = sizeForNode(node);
  const position = worldPosition(nodes, node);
  return {
    id: node.id,
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
  };
}

export function toRelativeChildCoords(
  nodes: readonly SessionCanvasNode[]
): SessionCanvasNode[] {
  return nodes.map((node) => {
    if (!node.parentId || node.expanded) return node;
    const parent = nodeById(nodes, node.parentId);
    if (!parent) return node;
    return { ...node, x: node.x - parent.x, y: node.y - parent.y };
  });
}

export function isGroupNode(node: SessionCanvasNode): boolean {
  return node.kind === 'group';
}

export function orderCanvasNodes(
  nodes: readonly SessionCanvasNode[]
): SessionCanvasNode[] {
  return [...nodes].sort((left, right) => {
    const depthDelta = groupDepth(nodes, left.id) - groupDepth(nodes, right.id);
    if (depthDelta !== 0) return depthDelta;
    if (isGroupNode(left) === isGroupNode(right)) return 0;
    return isGroupNode(left) ? -1 : 1;
  });
}

const CANVAS_STACK_BAND = 32;
const CANVAS_STACK_DRAG_BOOST = 10_000;
const CANVAS_STACK_SELECT_BOOST = 1_000;
const EMPTY_CHILDREN: SessionCanvasNode[] = [];

export type CanvasNodeIndex = {
  byId: Map<string, SessionCanvasNode>;
  children: Map<string, SessionCanvasNode[]>;
  roots: string[];
  rootOf: Map<string, string>;
  depthOf: Map<string, number>;
  groupNumberOf: Map<string, number>;
};

const NODE_INDEXES = new WeakMap<object, CanvasNodeIndex>();

function buildCanvasNodeIndex(
  nodes: readonly SessionCanvasNode[]
): CanvasNodeIndex {
  const byId = new Map<string, SessionCanvasNode>();
  const children = new Map<string, SessionCanvasNode[]>();
  for (const node of nodes) {
    byId.set(node.id, node);
    if (!node.parentId) continue;
    const siblings = children.get(node.parentId);
    if (siblings) siblings.push(node);
    else children.set(node.parentId, [node]);
  }

  const rootOf = new Map<string, string>();
  const depthOf = new Map<string, number>();
  const ancestorRoot = (id: string): { rootId: string; depth: number } => {
    const cachedRoot = rootOf.get(id);
    if (cachedRoot != null) {
      return { rootId: cachedRoot, depth: depthOf.get(id) ?? 0 };
    }
    const seen = new Set<string>();
    let current = byId.get(id);
    let depth = 0;
    while (current?.parentId) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      const parent = byId.get(current.parentId);
      if (!parent) break;
      current = parent;
      depth += 1;
    }
    const rootId = current?.id ?? id;
    rootOf.set(id, rootId);
    depthOf.set(id, depth);
    return { rootId, depth };
  };

  const roots: string[] = [];
  const seenRoots = new Set<string>();
  for (const node of nodes) {
    const { rootId } = ancestorRoot(node.id);
    if (seenRoots.has(rootId)) continue;
    seenRoots.add(rootId);
    roots.push(rootId);
  }

  const groupNumberOf = new Map<string, number>();
  const groups = nodes
    .filter(isGroupNode)
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || left.id.localeCompare(right.id)
    );
  groups.forEach((group, index) => {
    groupNumberOf.set(group.id, index + 1);
  });

  return { byId, children, roots, rootOf, depthOf, groupNumberOf };
}

export function canvasNodeIndex(
  nodes: readonly SessionCanvasNode[]
): CanvasNodeIndex {
  const cached = NODE_INDEXES.get(nodes);
  if (cached) return cached;
  const built = buildCanvasNodeIndex(nodes);
  NODE_INDEXES.set(nodes, built);
  return built;
}

export function rootAncestorId(
  nodes: readonly SessionCanvasNode[],
  id: string
): string {
  return canvasNodeIndex(nodes).rootOf.get(id) ?? id;
}

export function canvasNodeZIndex(
  nodes: readonly SessionCanvasNode[],
  node: SessionCanvasNode,
  options: {
    draggedId?: string | null;
    selectedIds?: ReadonlySet<string>;
  } = {}
): number {
  const index = canvasNodeIndex(nodes);
  const rootId = index.rootOf.get(node.id) ?? node.id;
  const rootIndex = Math.max(0, index.roots.indexOf(rootId));
  const depth = index.depthOf.get(node.id) ?? 0;
  const local = isGroupNode(node)
    ? depth * 2
    : depth * 2 + (node.expanded ? 3 : 1);
  let boost = 0;
  if (
    options.draggedId &&
    (index.rootOf.get(options.draggedId) ?? options.draggedId) === rootId
  ) {
    boost += CANVAS_STACK_DRAG_BOOST;
  }
  if (options.selectedIds) {
    for (const id of options.selectedIds) {
      if ((index.rootOf.get(id) ?? id) === rootId) {
        boost += CANVAS_STACK_SELECT_BOOST;
        break;
      }
    }
  }
  return rootIndex * CANVAS_STACK_BAND + local + boost;
}

export function isSessionNode(node: SessionCanvasNode): boolean {
  return node.kind !== 'group';
}

export function uniqueGroupName(
  base: string,
  nodes: readonly SessionCanvasNode[],
  exceptId?: string
): string {
  const trimmed = base.trim() || '分组';
  const taken = new Set(
    nodes
      .filter((node) => isGroupNode(node) && node.id !== exceptId)
      .map((node) => node.name)
  );
  if (!taken.has(trimmed)) return trimmed;
  let index = 1;
  while (taken.has(`${trimmed}_${index}`)) index += 1;
  return `${trimmed}_${index}`;
}

export function groupNumber(
  nodes: readonly SessionCanvasNode[],
  groupId: string
): number {
  return canvasNodeIndex(nodes).groupNumberOf.get(groupId) ?? 0;
}

export function directChildren(
  nodes: readonly SessionCanvasNode[],
  parentId: string
): SessionCanvasNode[] {
  return canvasNodeIndex(nodes).children.get(parentId) ?? EMPTY_CHILDREN;
}

export function nodeById(
  nodes: readonly SessionCanvasNode[],
  id: string
): SessionCanvasNode | undefined {
  return canvasNodeIndex(nodes).byId.get(id);
}

export function containingGroupId(node: SessionCanvasNode): string | null {
  return isGroupNode(node) ? node.id : node.parentId;
}

export function groupDepth(
  nodes: readonly SessionCanvasNode[],
  id: string
): number {
  return canvasNodeIndex(nodes).depthOf.get(id) ?? 0;
}

export function groupHasRunningSession(
  nodes: readonly SessionCanvasNode[],
  groupId: string,
  runningSessionIds: ReadonlySet<string>
): boolean {
  if (runningSessionIds.size === 0) return false;
  return nodes.some(
    (node) =>
      isSessionNode(node) &&
      runningSessionIds.has(node.sessionId) &&
      (node.parentId === groupId || belongsToAncestor(nodes, node, groupId))
  );
}

export function selectedSessionIdsForViewed(
  nodes: readonly SessionCanvasNode[],
  selectedIds: ReadonlySet<string>
): string[] {
  const ids: string[] = [];
  for (const id of selectedIds) {
    const node = nodeById(nodes, id);
    if (node && isSessionNode(node) && node.sessionId) {
      ids.push(node.sessionId);
    }
  }
  return ids;
}

export function groupSessionCount(
  nodes: readonly SessionCanvasNode[],
  groupId: string
): number {
  return nodes.filter(
    (node) =>
      isSessionNode(node) &&
      !node.expanded &&
      (node.parentId === groupId || belongsToAncestor(nodes, node, groupId))
  ).length;
}

function belongsToAncestor(
  nodes: readonly SessionCanvasNode[],
  node: SessionCanvasNode,
  ancestorId: string
): boolean {
  let current = node.parentId ? nodeById(nodes, node.parentId) : undefined;
  const seen = new Set<string>();
  while (current) {
    if (current.id === ancestorId) return true;
    if (seen.has(current.id)) return false;
    seen.add(current.id);
    current = current.parentId ? nodeById(nodes, current.parentId) : undefined;
  }
  return false;
}

export function expandSelectionToGroups(
  nodes: readonly SessionCanvasNode[],
  selectedIds: ReadonlySet<string>
): Set<string> {
  const next = new Set(selectedIds);
  for (const id of selectedIds) {
    const node = nodeById(nodes, id);
    if (node && isDetachedSessionWindow(node) && node.openedFromId) {
      next.add(node.openedFromId);
    }
  }
  for (const id of [...next]) {
    const node = nodeById(nodes, id);
    if (!node || isGroupNode(node)) continue;
    if (node.parentId) next.add(node.parentId);
  }
  return next;
}

export function excludeSelectedGroupChildren(
  nodes: readonly SessionCanvasNode[],
  selectedIds: ReadonlySet<string>
): Set<string> {
  const next = new Set<string>();
  for (const id of selectedIds) {
    const node = nodeById(nodes, id);
    if (!node) continue;
    let ancestor = node.parentId ? nodeById(nodes, node.parentId) : undefined;
    let covered = false;
    const seen = new Set<string>();
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      if (selectedIds.has(ancestor.id)) {
        covered = true;
        break;
      }
      ancestor = ancestor.parentId
        ? nodeById(nodes, ancestor.parentId)
        : undefined;
    }
    if (!covered) next.add(id);
  }
  return next;
}

export function collectSelectionForRemoval(
  nodes: readonly SessionCanvasNode[],
  selectedIds: ReadonlySet<string>
): Set<string> {
  const next = new Set(selectedIds);
  for (const id of selectedIds) {
    const node = nodeById(nodes, id);
    if (!node || !isGroupNode(node)) continue;
    for (const child of nodes) {
      if (child.parentId === id || belongsToAncestor(nodes, child, id)) {
        next.add(child.id);
      }
    }
  }
  return next;
}

export function emptyGroupFootprint(): { width: number; height: number } {
  return {
    width: groupWidthForColumns(EMPTY_GROUP_COLUMNS),
    height: groupHeightForRows(EMPTY_GROUP_ROWS),
  };
}

function rectsConflict(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
  gap = CARD_GAP
): boolean {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}

export function findEmptyCanvasPlacement(
  nodes: readonly SessionCanvasNode[],
  size: { width: number; height: number },
  preferred: { x: number; y: number }
): { x: number; y: number } {
  const occupied = nodes
    .filter((node) => !node.parentId)
    .map((node) => worldRect(nodes, node));

  const fits = (x: number, y: number) =>
    occupied.every(
      (rect) =>
        !rectsConflict({ x, y, width: size.width, height: size.height }, rect)
    );

  if (fits(preferred.x, preferred.y)) return preferred;

  const stepX = size.width + CARD_GAP;
  const stepY = size.height + CARD_GAP;
  for (let ring = 1; ring <= 16; ring += 1) {
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = preferred.x + dx * stepX;
        const y = preferred.y + dy * stepY;
        if (fits(x, y)) return { x, y };
      }
    }
  }

  if (occupied.length === 0) return preferred;
  const maxRight = Math.max(...occupied.map((rect) => rect.x + rect.width));
  const minY = Math.min(...occupied.map((rect) => rect.y));
  return { x: maxRight + CARD_GAP, y: minY };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function lockedGridSize(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.round(value)
    : undefined;
}

export function planSessionGrid(
  count: number,
  group: Pick<SessionCanvasNode, 'showAll' | 'manualColumns' | 'manualRows'>
): {
  columns: number;
  rows: number;
  visible: number;
  overflow: number;
} {
  if (count <= 0) {
    return {
      columns: EMPTY_GROUP_COLUMNS,
      rows: EMPTY_GROUP_ROWS,
      visible: 0,
      overflow: 0,
    };
  }

  const showAll = group.showAll === true;
  const manualColumns = lockedGridSize(group.manualColumns);
  const manualRows = lockedGridSize(group.manualRows);

  let columns: number;
  let rows: number;

  if (showAll) {
    if (manualColumns != null) {
      columns = clampInt(manualColumns, 1, MAX_GROUP_COLUMNS);
      rows = Math.max(1, Math.ceil(count / columns));
    } else if (manualRows != null) {
      rows = Math.max(1, manualRows);
      columns = clampInt(Math.ceil(count / rows), 1, MAX_GROUP_COLUMNS);
      rows = Math.max(rows, Math.ceil(count / columns));
    } else {
      columns = DEFAULT_GROUP_COLUMNS;
      rows = Math.max(1, Math.ceil(count / columns));
    }
  } else if (manualColumns != null && manualRows != null) {
    columns = clampInt(manualColumns, 1, MAX_GROUP_COLUMNS);
    rows = clampInt(manualRows, 1, MAX_GROUP_ROWS);
  } else if (manualColumns != null) {
    columns = clampInt(manualColumns, 1, MAX_GROUP_COLUMNS);
    rows = clampInt(Math.ceil(count / columns), 1, MAX_GROUP_ROWS);
  } else if (manualRows != null) {
    rows = clampInt(manualRows, 1, MAX_GROUP_ROWS);
    columns = clampInt(Math.ceil(count / rows), 1, MAX_GROUP_COLUMNS);
  } else {
    columns = DEFAULT_GROUP_COLUMNS;
    rows = clampInt(Math.ceil(count / columns), 1, MAX_GROUP_ROWS);
  }

  const capacity = Math.max(1, columns * rows);
  const visible = showAll ? count : Math.min(count, capacity);
  return {
    columns,
    rows,
    visible,
    overflow: Math.max(0, count - visible),
  };
}

export function groupGridSize(
  sessionCount: number,
  showAll = false
): { width: number; height: number; rows: number; visible: number } {
  const plan = planSessionGrid(sessionCount, { showAll });
  return {
    width: groupWidthForColumns(plan.columns),
    height: groupHeightForRows(plan.rows, plan.overflow > 0),
    rows: plan.rows,
    visible: plan.visible,
  };
}

function replaceNodes(
  nodes: readonly SessionCanvasNode[],
  updates: Map<string, SessionCanvasNode>
): SessionCanvasNode[] {
  return nodes.map((node) => updates.get(node.id) ?? node);
}

export function isContainerGroup(
  nodes: readonly SessionCanvasNode[],
  groupId: string
): boolean {
  return directChildren(nodes, groupId).some(isGroupNode);
}

function movableGroupChildren(
  nodes: readonly SessionCanvasNode[],
  groupId: string,
  hidden: ReadonlySet<string>
): SessionCanvasNode[] {
  return directChildren(nodes, groupId).filter((node) => {
    if (hidden.has(node.id)) return false;
    if (isGroupNode(node)) return true;
    return isSessionNode(node) && !node.expanded;
  });
}

export function containerMinSize(
  nodes: readonly SessionCanvasNode[],
  groupId: string
): { width: number; height: number } {
  const children = movableGroupChildren(nodes, groupId, new Set());
  if (children.length === 0) return emptyGroupFootprint();
  let maxWidth = 0;
  let maxHeight = 0;
  for (const child of children) {
    const size = sizeForNode(child);
    maxWidth = Math.max(maxWidth, size.width);
    maxHeight = Math.max(maxHeight, size.height);
  }
  return {
    width: GROUP_PAD * 2 + maxWidth,
    height: GROUP_HEADER_HEIGHT + GROUP_PAD * 2 + maxHeight,
  };
}

function contentOrigin(): { x: number; y: number } {
  return { x: GROUP_PAD, y: GROUP_HEADER_HEIGHT + GROUP_PAD };
}

function childFitsInGroup(
  group: Pick<SessionCanvasNode, 'width' | 'height'>,
  child: SessionCanvasNode
): boolean {
  const size = sizeForNode(child);
  const origin = contentOrigin();
  return (
    child.x >= origin.x - 0.5 &&
    child.y >= origin.y - 0.5 &&
    child.x + size.width <= group.width - GROUP_PAD + 0.5 &&
    child.y + size.height <= group.height - GROUP_PAD + 0.5
  );
}

function clampChildInGroup(
  group: Pick<SessionCanvasNode, 'width' | 'height'>,
  child: SessionCanvasNode
): { x: number; y: number } {
  const size = sizeForNode(child);
  const origin = contentOrigin();
  const maxX = group.width - GROUP_PAD - size.width;
  const maxY = group.height - GROUP_PAD - size.height;
  return {
    x: Math.min(Math.max(child.x, origin.x), Math.max(origin.x, maxX)),
    y: Math.min(Math.max(child.y, origin.y), Math.max(origin.y, maxY)),
  };
}

function boundingContainerSize(
  children: readonly SessionCanvasNode[],
  extra?: { x: number; y: number; width: number; height: number } | null
): { width: number; height: number } {
  if (children.length === 0 && !extra) return emptyGroupFootprint();
  let right = GROUP_PAD;
  let bottom = GROUP_HEADER_HEIGHT + GROUP_PAD;
  for (const child of children) {
    const size = sizeForNode(child);
    right = Math.max(right, child.x + size.width);
    bottom = Math.max(bottom, child.y + size.height);
  }
  if (extra) {
    right = Math.max(right, extra.x + extra.width);
    bottom = Math.max(bottom, extra.y + extra.height);
  }
  return { width: right + GROUP_PAD, height: bottom + GROUP_PAD };
}

function findFreeContainerSlot(
  group: SessionCanvasNode,
  others: readonly SessionCanvasNode[],
  size: { width: number; height: number }
): { x: number; y: number } {
  const origin = contentOrigin();
  if (others.length === 0) return origin;
  const sorted = [...others].sort((left, right) =>
    left.y !== right.y ? left.y - right.y : left.x - right.x
  );
  const last = sorted[sorted.length - 1]!;
  const lastSize = sizeForNode(last);
  const rightX = last.x + lastSize.width + GROUP_GAP;
  if (rightX + size.width <= group.width - GROUP_PAD) {
    return { x: rightX, y: last.y };
  }
  return { x: origin.x, y: last.y + lastSize.height + GROUP_GAP };
}

function packContainerChildren(
  children: readonly SessionCanvasNode[],
  axis: 'x' | 'y',
  limit: number
): Map<string, { x: number; y: number }> {
  const origin = contentOrigin();
  const ordered = [...children].sort((left, right) =>
    axis === 'x'
      ? left.y !== right.y
        ? left.y - right.y
        : left.x - right.x
      : left.x !== right.x
        ? left.x - right.x
        : left.y - right.y
  );
  const positions = new Map<string, { x: number; y: number }>();
  let cursor = axis === 'x' ? origin.x : origin.y;
  let bandStart = axis === 'x' ? origin.y : origin.x;
  let band = 0;
  const start = axis === 'x' ? origin.x : origin.y;
  for (const child of ordered) {
    const size = sizeForNode(child);
    const span = axis === 'x' ? size.width : size.height;
    const cross = axis === 'x' ? size.height : size.width;
    if (cursor > start && cursor + span > start + limit) {
      cursor = start;
      bandStart += band + GROUP_GAP;
      band = 0;
    }
    positions.set(
      child.id,
      axis === 'x' ? { x: cursor, y: bandStart } : { x: bandStart, y: cursor }
    );
    cursor += span + GROUP_GAP;
    band = Math.max(band, cross);
  }
  return positions;
}

function relayoutNestedInternals(
  nodes: readonly SessionCanvasNode[],
  groupId: string
): SessionCanvasNode[] {
  let next = nodes as SessionCanvasNode[];
  for (const child of directChildren(next, groupId).filter(isGroupNode)) {
    next = relayoutGroup(next, child.id);
  }
  return next;
}

function relayoutContainerGroup(
  nodes: readonly SessionCanvasNode[],
  groupId: string,
  options?: {
    extraSlots?: number;
    hideChildIds?: ReadonlySet<string>;
    liveFrame?: { width?: number; height?: number };
    packAxis?: 'x' | 'y';
  }
): SessionCanvasNode[] {
  const group = nodeById(nodes, groupId);
  if (!group || !isGroupNode(group)) return [...nodes];
  if (group.collapsed) {
    return replaceNodes(
      nodes,
      new Map([[group.id, { ...group, height: GROUP_COLLAPSED_HEIGHT }]])
    );
  }

  const hidden = options?.hideChildIds ?? new Set<string>();
  const next = relayoutNestedInternals(nodes, groupId);
  const liveGroup = nodeById(next, groupId);
  if (!liveGroup) return [...nodes];

  const children = movableGroupChildren(next, groupId, hidden);
  const updates = new Map<string, SessionCanvasNode>();
  if (options?.packAxis) {
    const min = containerMinSize(next, groupId);
    const limit =
      options.packAxis === 'x'
        ? Math.max(
            (options.liveFrame?.width ?? liveGroup.width) - GROUP_PAD * 2,
            min.width - GROUP_PAD * 2
          )
        : Math.max(
            (options.liveFrame?.height ?? liveGroup.height) -
              GROUP_HEADER_HEIGHT -
              GROUP_PAD * 2,
            min.height - GROUP_HEADER_HEIGHT - GROUP_PAD * 2
          );
    const packed = packContainerChildren(children, options.packAxis, limit);
    for (const child of children) {
      const position = packed.get(child.id);
      if (position) updates.set(child.id, { ...child, ...position });
    }
  }

  const placed = children.map((child) => updates.get(child.id) ?? child);
  let extra: { x: number; y: number; width: number; height: number } | null =
    null;
  if ((options?.extraSlots ?? 0) > 0) {
    const slot = findFreeContainerSlot(liveGroup, placed, {
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    });
    extra = { ...slot, width: CARD_WIDTH, height: CARD_HEIGHT };
  }
  const content = boundingContainerSize(placed, extra);
  const min = containerMinSize(replaceNodes(next, updates), groupId);
  const packAxis = options?.packAxis;
  const live = options?.liveFrame;
  let width = liveGroup.width;
  let height = liveGroup.height;
  if (packAxis === 'x') {
    width = Math.max(live?.width ?? liveGroup.width, min.width);
    height = Math.max(content.height, min.height);
  } else if (packAxis === 'y') {
    height = Math.max(live?.height ?? liveGroup.height, min.height);
    width = Math.max(content.width, min.width);
  } else {
    width = Math.max(
      liveGroup.width,
      content.width,
      live?.width ?? 0,
      min.width
    );
    height = Math.max(
      liveGroup.height,
      content.height,
      live?.height ?? 0,
      min.height
    );
  }
  updates.set(liveGroup.id, { ...liveGroup, width, height });
  return replaceNodes(next, updates);
}

export function relayoutGroup(
  nodes: readonly SessionCanvasNode[],
  groupId: string,
  options?: {
    extraSlots?: number;
    hideChildIds?: ReadonlySet<string>;
    liveFrame?: { width?: number; height?: number };
    packAxis?: 'x' | 'y';
  }
): SessionCanvasNode[] {
  const group = nodeById(nodes, groupId);
  if (!group || !isGroupNode(group)) return [...nodes];
  if (isContainerGroup(nodes, groupId) || options?.packAxis) {
    return relayoutContainerGroup(nodes, groupId, options);
  }
  if (group.collapsed) {
    return replaceNodes(
      nodes,
      new Map([[group.id, { ...group, height: GROUP_COLLAPSED_HEIGHT }]])
    );
  }

  const hidden = options?.hideChildIds ?? new Set<string>();
  const sessions = directChildren(nodes, groupId).filter(
    (node) => isSessionNode(node) && !node.expanded && !hidden.has(node.id)
  );
  const occupancy = sessions.length + Math.max(0, options?.extraSlots ?? 0);
  const updates = new Map<string, SessionCanvasNode>();

  let cursorY = GROUP_HEADER_HEIGHT + GROUP_PAD;
  const originX = GROUP_PAD;
  const empty = occupancy === 0;
  const plan = planSessionGrid(occupancy, group);
  const columns = plan.columns;
  const overflow = Math.max(
    0,
    occupancy - (group.showAll ? occupancy : plan.visible)
  );
  const bothLocked =
    lockedGridSize(group.manualColumns) != null &&
    lockedGridSize(group.manualRows) != null;

  sessions.forEach((session, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    updates.set(session.id, {
      ...session,
      x: originX + col * (CARD_WIDTH + GROUP_GAP),
      y: cursorY + row * (CARD_HEIGHT + GROUP_GAP),
    });
  });

  const sessionRows = empty
    ? EMPTY_GROUP_ROWS
    : occupancy === 0
      ? 0
      : bothLocked && !group.showAll
        ? plan.rows
        : Math.max(
            1,
            Math.ceil((group.showAll ? occupancy : plan.visible) / columns)
          );
  if (sessionRows > 0) {
    cursorY +=
      sessionRows * CARD_HEIGHT + Math.max(0, sessionRows - 1) * GROUP_GAP;
  }

  const contentHeight =
    cursorY + GROUP_PAD + (overflow > 0 ? GROUP_FOOTER_HEIGHT : 0);
  const width = groupWidthForColumns(columns);
  const height = empty
    ? groupHeightForRows(EMPTY_GROUP_ROWS)
    : Math.max(contentHeight, groupHeightForRows(sessionRows, overflow > 0));
  const live = options?.liveFrame;
  updates.set(group.id, {
    ...group,
    ...(empty && live == null
      ? { manualColumns: undefined, manualRows: undefined }
      : {}),
    width: live?.width ?? width,
    height: live?.height ?? height,
  });

  return replaceNodes(nodes, updates);
}

export function relayoutAncestors(
  nodes: readonly SessionCanvasNode[],
  startId: string | null
): SessionCanvasNode[] {
  let next = [...nodes];
  let currentId = startId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    next = relayoutGroup(next, currentId);
    currentId = nodeById(next, currentId)?.parentId ?? null;
  }
  return next;
}

export function createEmptyGroup(
  nodes: readonly SessionCanvasNode[],
  position: { x: number; y: number },
  name = '分组'
): SessionCanvasNode[] {
  const size = emptyGroupFootprint();
  const group: SessionCanvasNode = {
    id: createCanvasInstanceId(),
    kind: 'group',
    sessionId: '',
    parentId: null,
    name: uniqueGroupName(name, nodes),
    createdAt: Date.now(),
    showAll: false,
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
    expanded: false,
  };
  return relayoutGroup([...nodes, group], group.id);
}

export function importSessionsAsGroup(
  nodes: readonly SessionCanvasNode[],
  sessionIds: readonly string[],
  name: string,
  origin: { x: number; y: number }
): SessionCanvasNode[] {
  const present = new Set(
    nodes.filter(isSessionNode).map((node) => node.sessionId)
  );
  const incoming = sessionIds.filter((id) => !present.has(id));
  if (incoming.length === 0) return [...nodes];

  const group: SessionCanvasNode = {
    id: createCanvasInstanceId(),
    kind: 'group',
    sessionId: '',
    parentId: null,
    name: uniqueGroupName(name, nodes),
    createdAt: Date.now(),
    showAll: false,
    x: origin.x,
    y: origin.y,
    width: groupGridSize(incoming.length).width,
    height: groupGridSize(incoming.length).height,
    expanded: false,
  };
  const cards = incoming.map((sessionId) => ({
    ...createCanvasNode(sessionId, origin),
    parentId: group.id,
  }));
  return relayoutGroup([...nodes, group, ...cards], group.id);
}

function selectedRoots(
  nodes: readonly SessionCanvasNode[],
  selectedIds: ReadonlySet<string>
): SessionCanvasNode[] {
  const expanded = expandSelectionToGroups(nodes, selectedIds);
  return nodes.filter((node) => {
    if (!expanded.has(node.id)) return false;
    if (node.parentId && expanded.has(node.parentId)) return false;
    if (isDetachedSessionWindow(node)) return false;
    return true;
  });
}

export function canGroupSelection(
  nodes: readonly SessionCanvasNode[],
  selectedIds: ReadonlySet<string>
): boolean {
  const roots = selectedRoots(nodes, selectedIds);
  if (roots.length < 2) return false;
  if (roots.some((node) => groupDepth(nodes, node.id) > 0)) return false;
  if (
    roots.some(
      (node) =>
        isGroupNode(node) && directChildren(nodes, node.id).some(isGroupNode)
    )
  ) {
    return false;
  }
  return true;
}

export function groupSelection(
  nodes: readonly SessionCanvasNode[],
  selectedIds: ReadonlySet<string>,
  name = '分组'
): SessionCanvasNode[] {
  const roots = selectedRoots(nodes, selectedIds);
  if (roots.length < 2) return [...nodes];
  if (roots.some((node) => groupDepth(nodes, node.id) > 0)) {
    return [...nodes];
  }
  if (
    roots.some(
      (node) =>
        isGroupNode(node) && directChildren(nodes, node.id).some(isGroupNode)
    )
  ) {
    return [...nodes];
  }

  const worlds = roots.map((node) => worldPosition(nodes, node));
  const sessionCount = roots.filter(isSessionNode).length;
  const columns = DEFAULT_GROUP_COLUMNS;
  const group: SessionCanvasNode = {
    id: createCanvasInstanceId(),
    kind: 'group',
    sessionId: '',
    parentId: null,
    name: uniqueGroupName(name, nodes),
    createdAt: Date.now(),
    showAll: false,
    x: Math.min(...worlds.map((point) => point.x)) - GROUP_PAD,
    y:
      Math.min(...worlds.map((point) => point.y)) -
      GROUP_HEADER_HEIGHT -
      GROUP_PAD,
    width: groupWidthForColumns(columns),
    height: groupHeightForRows(Math.max(1, Math.ceil(sessionCount / columns))),
    expanded: false,
  };
  const next = nodes.map((node) => {
    if (!roots.some((root) => root.id === node.id)) return node;
    const collapsed =
      isSessionNode(node) && node.expanded ? collapseNode(node) : node;
    return { ...collapsed, parentId: group.id };
  });
  return relayoutGroup(
    [group, ...next],
    group.id,
    roots.some(isGroupNode) ? { packAxis: 'x' } : undefined
  );
}

export function dissolveGroup(
  nodes: readonly SessionCanvasNode[],
  groupId: string
): SessionCanvasNode[] {
  const group = nodeById(nodes, groupId);
  if (!group || !isGroupNode(group)) return [...nodes];
  const parentId = group.parentId;
  const next = nodes
    .filter((node) => node.id !== groupId)
    .map((node) => (node.parentId === groupId ? { ...node, parentId } : node));
  return parentId ? relayoutGroup(next, parentId) : next;
}

export function detachNode(
  nodes: readonly SessionCanvasNode[],
  childId: string,
  world: { x: number; y: number }
): SessionCanvasNode[] {
  const child = nodeById(nodes, childId);
  if (!child?.parentId) {
    return nodes.map((node) =>
      node.id === childId ? { ...node, x: world.x, y: world.y } : node
    );
  }
  const previousParent = child.parentId;
  const next = nodes.map((node) =>
    node.id === childId
      ? { ...node, parentId: null, x: world.x, y: world.y }
      : node
  );
  return relayoutGroup(next, previousParent);
}

export function canAcceptGroupMember(
  nodes: readonly SessionCanvasNode[],
  childId: string,
  groupId: string
): boolean {
  const child = nodeById(nodes, childId);
  const group = nodeById(nodes, groupId);
  if (!child || !group || !isGroupNode(group) || child.id === groupId) {
    return false;
  }
  if (belongsToAncestor(nodes, group, childId)) return false;
  if (isGroupNode(child)) {
    return (
      groupDepth(nodes, groupId) === 0 &&
      !directChildren(nodes, child.id).some(isGroupNode)
    );
  }
  return groupDepth(nodes, groupId) < MAX_GROUP_DEPTH;
}

export function attachToGroup(
  nodes: readonly SessionCanvasNode[],
  childId: string,
  groupId: string
): SessionCanvasNode[] {
  if (!canAcceptGroupMember(nodes, childId, groupId)) return [...nodes];
  const child = nodeById(nodes, childId);
  const group = nodeById(nodes, groupId);
  if (!child || !group) return [...nodes];
  const previousParent = child.parentId;
  let next = nodes.map((node) =>
    node.id === childId ? { ...node, parentId: groupId } : node
  );
  if (previousParent) next = relayoutGroup(next, previousParent);
  if (isContainerGroup(next, groupId)) {
    const host = nodeById(next, groupId);
    const moved = nodeById(next, childId);
    if (host && moved) {
      const others = movableGroupChildren(next, groupId, new Set([childId]));
      const slot = findFreeContainerSlot(host, others, sizeForNode(moved));
      next = next.map((node) =>
        node.id === childId ? { ...node, x: slot.x, y: slot.y } : node
      );
    }
  }
  return relayoutGroup(next, groupId);
}

export function dropOnTarget(
  nodes: readonly SessionCanvasNode[],
  draggedId: string,
  targetId: string
): SessionCanvasNode[] {
  if (draggedId === targetId) return [...nodes];
  const dragged = nodeById(nodes, draggedId);
  const target = nodeById(nodes, targetId);
  if (!dragged || !target) return [...nodes];
  if (target.expanded) return [...nodes];

  let next = nodes as SessionCanvasNode[];
  if (dragged.expanded && isSessionNode(dragged)) {
    next = next.map((node) =>
      node.id === draggedId ? collapseNode(node) : node
    );
  }

  const liveDragged = nodeById(next, draggedId);
  if (!liveDragged) return [...nodes];

  const targetGroupId = isGroupNode(target) ? target.id : target.parentId;
  if (targetGroupId) {
    return attachToGroup(next, draggedId, targetGroupId);
  }
  if (isGroupNode(liveDragged) || isGroupNode(target)) {
    return next;
  }
  return groupSelection(next, new Set([draggedId, targetId]));
}

export function dragHitRect(
  node: SessionCanvasNode,
  world: { x: number; y: number }
): { x: number; y: number; width: number; height: number } {
  if (isSessionNode(node) && node.expanded) {
    return {
      x: world.x,
      y: world.y,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    };
  }
  const size = sizeForNode(node);
  return {
    x: world.x,
    y: world.y,
    width: size.width,
    height: size.height,
  };
}

export type CanvasDropHint =
  | { type: 'canvas'; x: number; y: number }
  | { type: 'group'; groupId: string }
  | { type: 'same'; groupId: string }
  | {
      type: 'merge';
      targetId: string;
      rect: { x: number; y: number; width: number; height: number };
    };

export const CANVAS_DROP_HINT: CanvasDropHint = { type: 'canvas', x: 0, y: 0 };

export function dropHintsEqual(
  left: CanvasDropHint | null,
  right: CanvasDropHint | null
): boolean {
  if (left === right) return true;
  if (!left || !right || left.type !== right.type) return false;
  switch (left.type) {
    case 'canvas':
      return true;
    case 'group':
    case 'same':
      return left.groupId === right.groupId;
    case 'merge':
      return (
        left.targetId === right.targetId &&
        left.rect.x === right.rect.x &&
        left.rect.y === right.rect.y &&
        left.rect.width === right.rect.width &&
        left.rect.height === right.rect.height
      );
  }
}

export function visualDropHint(
  hint: CanvasDropHint | null
): CanvasDropHint | null {
  if (!hint) return null;
  return hint.type === 'canvas' ? CANVAS_DROP_HINT : hint;
}

export function flowPositionToWorld(
  nodes: readonly SessionCanvasNode[],
  node: SessionCanvasNode,
  position: { x: number; y: number }
): { x: number; y: number } {
  const parent =
    node.parentId && !node.expanded
      ? nodeById(nodes, node.parentId)
      : undefined;
  if (!parent) return position;
  const origin = worldPosition(nodes, parent);
  return { x: origin.x + position.x, y: origin.y + position.y };
}

export type CanvasFlowLookups = {
  zIndex: (node: SessionCanvasNode) => number;
  groupNumber: (groupId: string) => number;
  sessionCount: (groupId: string) => number;
  isContainer: (groupId: string) => boolean;
  minSize: (groupId: string) => { width: number; height: number };
  groupRunning: (groupId: string) => boolean;
  groupReviewing: (groupId: string) => boolean;
};

export function buildCanvasFlowLookups(
  nodes: readonly SessionCanvasNode[],
  options: {
    draggedId?: string | null;
    selectedIds?: ReadonlySet<string>;
    runningSessionIds?: ReadonlySet<string>;
    reviewSessionIds?: ReadonlySet<string>;
  } = {}
): CanvasFlowLookups {
  const index = canvasNodeIndex(nodes);
  const running = options.runningSessionIds ?? new Set<string>();
  const review = options.reviewSessionIds ?? new Set<string>();
  const sessionCount = new Map<string, number>();
  const runningGroups = new Set<string>();
  const reviewGroups = new Set<string>();
  const containers = new Set<string>();

  for (const node of nodes) {
    if (isGroupNode(node)) {
      const kids = index.children.get(node.id) ?? EMPTY_CHILDREN;
      if (kids.some(isGroupNode)) containers.add(node.id);
    }
    if (!isSessionNode(node) || !node.sessionId) continue;
    let current = node.parentId ? index.byId.get(node.parentId) : undefined;
    const seen = new Set<string>();
    while (current && isGroupNode(current)) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      if (!node.expanded) {
        sessionCount.set(current.id, (sessionCount.get(current.id) ?? 0) + 1);
      }
      if (running.has(node.sessionId)) runningGroups.add(current.id);
      if (review.has(node.sessionId)) reviewGroups.add(current.id);
      current = current.parentId ? index.byId.get(current.parentId) : undefined;
    }
  }

  const minSizes = new Map<string, { width: number; height: number }>();
  for (const groupId of containers) {
    minSizes.set(groupId, containerMinSize(nodes, groupId));
  }

  const draggedRoot = options.draggedId
    ? (index.rootOf.get(options.draggedId) ?? options.draggedId)
    : null;
  const selectedRoots = new Set<string>();
  if (options.selectedIds) {
    for (const id of options.selectedIds) {
      selectedRoots.add(index.rootOf.get(id) ?? id);
    }
  }

  return {
    zIndex(node) {
      const rootId = index.rootOf.get(node.id) ?? node.id;
      const rootIndex = Math.max(0, index.roots.indexOf(rootId));
      const depth = index.depthOf.get(node.id) ?? 0;
      const local = isGroupNode(node)
        ? depth * 2
        : depth * 2 + (node.expanded ? 3 : 1);
      let boost = 0;
      if (draggedRoot === rootId) boost += CANVAS_STACK_DRAG_BOOST;
      if (selectedRoots.has(rootId)) boost += CANVAS_STACK_SELECT_BOOST;
      return rootIndex * CANVAS_STACK_BAND + local + boost;
    },
    groupNumber(groupId) {
      return index.groupNumberOf.get(groupId) ?? 0;
    },
    sessionCount(groupId) {
      return sessionCount.get(groupId) ?? 0;
    },
    isContainer(groupId) {
      return containers.has(groupId);
    },
    minSize(groupId) {
      return (
        minSizes.get(groupId) ?? {
          width: groupWidthForColumns(1),
          height: groupHeightForRows(1),
        }
      );
    },
    groupRunning(groupId) {
      return runningGroups.has(groupId);
    },
    groupReviewing(groupId) {
      return reviewGroups.has(groupId);
    },
  };
}

export function computeDropHint(
  nodes: readonly SessionCanvasNode[],
  draggedId: string,
  world: { x: number; y: number }
): CanvasDropHint {
  const dragged = nodeById(nodes, draggedId);
  if (!dragged) return { type: 'canvas', x: world.x, y: world.y };
  const hit = dragHitRect(dragged, world);
  const cx = hit.x + hit.width / 2;
  const cy = hit.y + hit.height / 2;
  const contains = (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) =>
    cx >= rect.x &&
    cx <= rect.x + rect.width &&
    cy >= rect.y &&
    cy <= rect.y + rect.height;

  let groupHit: SessionCanvasNode | undefined;
  let bestDepth = -1;
  for (const node of nodes) {
    if (!isGroupNode(node) || node.id === draggedId || node.collapsed) continue;
    if (belongsToAncestor(nodes, node, draggedId)) continue;
    const rect = worldRect(nodes, node);
    if (!contains(rect) && overlapRatio(hit, rect) < 0.18) continue;
    const isCurrentParent = dragged.parentId === node.id;
    if (!isCurrentParent && !canAcceptGroupMember(nodes, draggedId, node.id)) {
      continue;
    }
    const depth = groupDepth(nodes, node.id);
    if (!groupHit || depth > bestDepth) {
      groupHit = node;
      bestDepth = depth;
    }
  }
  if (groupHit) {
    if (dragged.parentId === groupHit.id) {
      return { type: 'same', groupId: groupHit.id };
    }
    return { type: 'group', groupId: groupHit.id };
  }

  if (isSessionNode(dragged) && !dragged.expanded) {
    let pin: SessionCanvasNode | undefined;
    for (const node of nodes) {
      if (node.id === draggedId || !isSessionNode(node) || node.expanded) {
        continue;
      }
      if (node.parentId || node.sessionId === dragged.sessionId) continue;
      const rect = worldRect(nodes, node);
      if (!contains(rect)) continue;
      pin = node;
    }
    if (pin) {
      const rect = worldRect(nodes, pin);
      return {
        type: 'merge',
        targetId: pin.id,
        rect: {
          x: rect.x - GROUP_PAD,
          y: rect.y - GROUP_HEADER_HEIGHT - GROUP_PAD,
          width: groupWidthForColumns(DEFAULT_GROUP_COLUMNS),
          height: groupHeightForRows(1),
        },
      };
    }
  }

  return { type: 'canvas', x: world.x, y: world.y };
}

export function previewCanvasDrop(
  nodes: readonly SessionCanvasNode[],
  draggedId: string | null,
  hint: CanvasDropHint | null
): SessionCanvasNode[] {
  if (!draggedId || !hint) return nodes as SessionCanvasNode[];
  const dragged = nodeById(nodes, draggedId);
  if (!dragged || !isSessionNode(dragged) || dragged.expanded) {
    return nodes as SessionCanvasNode[];
  }

  let next = nodes as SessionCanvasNode[];
  const sourceId = dragged.parentId;
  if (hint.type === 'group' && hint.groupId !== sourceId) {
    next = relayoutGroup(next, hint.groupId, { extraSlots: 1 });
  }
  if (
    sourceId &&
    hint.type !== 'same' &&
    !(hint.type === 'group' && hint.groupId === sourceId)
  ) {
    next = relayoutGroup(next, sourceId, {
      hideChildIds: new Set([draggedId]),
    });
  }
  return next;
}

export function nextOpenCardSlot(
  nodes: readonly SessionCanvasNode[],
  groupId: string
): { x: number; y: number } | null {
  const group = nodeById(nodes, groupId);
  if (!group || !isGroupNode(group) || group.collapsed) return null;
  if (isContainerGroup(nodes, groupId)) {
    const others = movableGroupChildren(nodes, groupId, new Set());
    return findFreeContainerSlot(group, others, {
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    });
  }
  const sessions = directChildren(nodes, groupId).filter(
    (node) => isSessionNode(node) && !node.expanded
  );
  const plan = planSessionGrid(sessions.length + 1, group);
  if (sessions.length >= plan.columns * plan.rows) return null;

  const index = sessions.length;
  return {
    x: GROUP_PAD + (index % plan.columns) * (CARD_WIDTH + GROUP_GAP),
    y:
      GROUP_HEADER_HEIGHT +
      GROUP_PAD +
      Math.floor(index / plan.columns) * (CARD_HEIGHT + GROUP_GAP),
  };
}

export function applyDropHint(
  nodes: readonly SessionCanvasNode[],
  draggedId: string,
  hint: CanvasDropHint
): SessionCanvasNode[] {
  switch (hint.type) {
    case 'same':
      if (isContainerGroup(nodes, hint.groupId)) {
        const host = nodeById(nodes, hint.groupId);
        if (!host) return [...nodes];
        const updates = new Map<string, SessionCanvasNode>();
        for (const child of movableGroupChildren(
          nodes,
          hint.groupId,
          new Set()
        )) {
          const clamped = clampChildInGroup(host, child);
          if (clamped.x !== child.x || clamped.y !== child.y) {
            updates.set(child.id, { ...child, ...clamped });
          }
        }
        return replaceNodes(nodes, updates);
      }
      return relayoutGroup(nodes, hint.groupId);
    case 'group':
      return attachToGroup(nodes, draggedId, hint.groupId);
    case 'merge':
      return groupSelection(nodes, new Set([draggedId, hint.targetId]));
    case 'canvas':
      return detachNode(nodes, draggedId, { x: hint.x, y: hint.y });
  }
}

export type GroupResizeAxis = 'x' | 'y' | 'xy';

export type GroupResizeOrigin = {
  width: number;
  height: number;
  axis?: GroupResizeAxis;
};

const RESIZE_AXIS_DEADZONE_PX = 3;

export function inferGroupResizeAxis(
  origin: GroupResizeOrigin,
  geometry: { width: number; height: number }
): GroupResizeAxis | undefined {
  if (origin.axis) return origin.axis;
  const dw = Math.abs(geometry.width - origin.width);
  const dh = Math.abs(geometry.height - origin.height);
  if (dw < RESIZE_AXIS_DEADZONE_PX && dh < RESIZE_AXIS_DEADZONE_PX) {
    return undefined;
  }
  if (dw >= RESIZE_AXIS_DEADZONE_PX && dh >= RESIZE_AXIS_DEADZONE_PX) {
    return 'xy';
  }
  return dw > dh ? 'x' : 'y';
}

function containerPackAxis(
  origin: GroupResizeOrigin,
  geometry: { width: number; height: number },
  nextSize: { width: number; height: number }
): 'x' | 'y' {
  const axis = inferGroupResizeAxis(origin, geometry);
  if (axis === 'y') return 'y';
  if (axis === 'x') return 'x';
  const shrinkX = origin.width - nextSize.width;
  const shrinkY = origin.height - nextSize.height;
  return shrinkY > shrinkX ? 'y' : 'x';
}

function resizeContainerFrame(
  nodes: readonly SessionCanvasNode[],
  groupId: string,
  geometry: { x: number; y: number; width: number; height: number },
  origin: GroupResizeOrigin | undefined
): SessionCanvasNode[] {
  const group = nodeById(nodes, groupId);
  if (!group || !isGroupNode(group)) return [...nodes];
  const min = containerMinSize(nodes, groupId);
  const width = Math.max(geometry.width, min.width);
  const height = Math.max(geometry.height, min.height);
  const positioned = nodes.map((node) =>
    node.id === groupId ? { ...node, x: geometry.x, y: geometry.y } : node
  );
  const children = movableGroupChildren(positioned, groupId, new Set());
  const allFit = children.every((child) =>
    childFitsInGroup({ width, height }, child)
  );
  if (allFit) {
    const next = positioned.map((node) =>
      node.id === groupId ? { ...node, width, height } : node
    );
    return group.parentId ? relayoutAncestors(next, group.parentId) : next;
  }

  const packAxis = containerPackAxis(origin ?? group, geometry, {
    width,
    height,
  });
  const liveFrame = packAxis === 'x' ? { width } : { height };
  const laidOut = relayoutGroup(positioned, groupId, { packAxis, liveFrame });
  const parentId = nodeById(laidOut, groupId)?.parentId ?? null;
  return parentId ? relayoutAncestors(laidOut, parentId) : laidOut;
}

function applyGroupResize(
  nodes: readonly SessionCanvasNode[],
  groupId: string,
  geometry: { x: number; y: number; width: number; height: number },
  origin: GroupResizeOrigin | undefined,
  mode: 'live' | 'commit'
): SessionCanvasNode[] {
  const group = nodeById(nodes, groupId);
  if (!group || !isGroupNode(group) || group.collapsed) return [...nodes];
  if (isContainerGroup(nodes, groupId)) {
    return resizeContainerFrame(nodes, groupId, geometry, origin);
  }
  const start = origin ?? group;
  const axis = inferGroupResizeAxis(start, geometry);
  const columns = columnsForGroupWidth(
    Math.max(geometry.width, groupWidthForColumns(1))
  );
  const rows = rowsForGroupHeight(
    Math.max(geometry.height, groupHeightForRows(1))
  );
  let manualColumns = group.manualColumns;
  let manualRows = group.manualRows;
  if (axis === 'x') {
    manualColumns = columns;
    manualRows = undefined;
  } else if (axis === 'y') {
    manualRows = rows;
    manualColumns = undefined;
  } else if (axis === 'xy') {
    manualColumns = columns;
    manualRows = rows;
  }
  const next = nodes.map((node) =>
    node.id === groupId
      ? {
          ...node,
          x: geometry.x,
          y: geometry.y,
          manualColumns,
          manualRows,
        }
      : node
  );
  if (mode === 'live') {
    const liveFrame =
      axis === 'x'
        ? { width: Math.max(geometry.width, groupWidthForColumns(1)) }
        : axis === 'y'
          ? { height: Math.max(geometry.height, groupHeightForRows(1)) }
          : {
              width: Math.max(geometry.width, groupWidthForColumns(1)),
              height: Math.max(geometry.height, groupHeightForRows(1)),
            };
    const laidOut = relayoutGroup(next, groupId, { liveFrame });
    const parentId = nodeById(laidOut, groupId)?.parentId ?? null;
    return parentId ? relayoutAncestors(laidOut, parentId) : laidOut;
  }
  return relayoutAncestors(next, groupId);
}

export function resizeGroupFrame(
  nodes: readonly SessionCanvasNode[],
  groupId: string,
  geometry: { x: number; y: number; width: number; height: number },
  origin?: GroupResizeOrigin
): SessionCanvasNode[] {
  return applyGroupResize(nodes, groupId, geometry, origin, 'commit');
}

export function previewGroupFrame(
  nodes: readonly SessionCanvasNode[],
  groupId: string,
  geometry: { x: number; y: number; width: number; height: number },
  origin?: GroupResizeOrigin
): SessionCanvasNode[] {
  return applyGroupResize(nodes, groupId, geometry, origin, 'live');
}

export function toggleGroupCollapsed(
  nodes: readonly SessionCanvasNode[],
  groupId: string
): SessionCanvasNode[] {
  const group = nodeById(nodes, groupId);
  if (!group || !isGroupNode(group)) return [...nodes];
  const next = nodes.map((node) =>
    node.id === groupId ? { ...node, collapsed: !node.collapsed } : node
  );
  return relayoutAncestors(next, groupId);
}

export function overlapRatio(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): number {
  const overlapX = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  );
  const overlapY = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  );
  const overlap = overlapX * overlapY;
  if (overlap <= 0) return 0;
  return overlap / Math.min(a.width * a.height, b.width * b.height);
}

export function hitTestNode(
  nodes: readonly SessionCanvasNode[],
  dragged: { x: number; y: number; width: number; height: number },
  excludeId?: string
): SessionCanvasNode | undefined {
  let best: SessionCanvasNode | undefined;
  let bestScore = 0.18;
  for (const node of nodes) {
    if (excludeId && node.id === excludeId) continue;
    if (excludeId && belongsToAncestor(nodes, node, excludeId)) continue;
    if (isSessionNode(node) && node.expanded) continue;
    if (isOverflowHidden(nodes, node)) continue;
    const size = sizeForNode(node);
    const rect = worldRect(nodes, node);
    const score = overlapRatio(dragged, {
      x: rect.x,
      y: rect.y,
      width: size.width,
      height: size.height,
    });
    const preferCard =
      best && isGroupNode(best) && isSessionNode(node) ? 0.02 : 0;
    if (score + preferCard > bestScore) {
      best = node;
      bestScore = score;
    }
  }
  return best;
}

export interface FlowGeometryChange {
  id: string;
  type: string;
  position?: { x: number; y: number };
  dimensions?: { width: number; height: number };
  dragging?: boolean;
}

export function applyFlowGeometryChanges(
  nodes: readonly SessionCanvasNode[],
  changes: readonly FlowGeometryChange[]
): SessionCanvasNode[] {
  let next = nodes as SessionCanvasNode[];
  let mutated = false;

  const write = (updated: SessionCanvasNode[]) => {
    next = updated;
    mutated = true;
  };

  const moving = new Set<string>();
  for (const change of changes) {
    if (change.type !== 'position' || !change.position) continue;
    if (change.dragging === false) continue;
    const id = parseCanvasNodeId(change.id);
    if (id) moving.add(id);
  }

  for (const change of changes) {
    if (change.type !== 'position' && change.type !== 'dimensions') continue;
    const instanceId = parseCanvasNodeId(change.id);
    if (!instanceId) continue;
    const current = nodeById(next, instanceId);
    if (!current) continue;

    if (change.type === 'position' && change.dragging === false) continue;
    if (
      isGroupNode(current) &&
      (change.type === 'dimensions' || change.dragging !== true)
    ) {
      continue;
    }

    if (change.type === 'position' && change.position) {
      const ancestorMoving = [...moving].some(
        (id) =>
          id !== instanceId &&
          (current.parentId === id || belongsToAncestor(next, current, id))
      );
      if (ancestorMoving) continue;
      const x = change.position.x;
      const y = change.position.y;
      if (x === current.x && y === current.y) continue;
      write(
        next.map((node) => (node.id === instanceId ? { ...node, x, y } : node))
      );
    }

    if (change.type === 'dimensions' && change.dimensions) {
      const width = change.dimensions.width;
      const height = change.dimensions.height;
      if (current.width === width && current.height === height) continue;
      write(
        next.map((node) =>
          node.id === instanceId ? { ...node, width, height } : node
        )
      );
    }
  }

  return mutated ? next : (nodes as SessionCanvasNode[]);
}

export function placeDetachedWindow(
  nodes: readonly SessionCanvasNode[],
  sourceId: string
): SessionCanvasNode[] {
  const source = nodeById(nodes, sourceId);
  if (!source || !isSessionNode(source) || !source.sessionId) return [...nodes];
  const parent = source.parentId ? nodeById(nodes, source.parentId) : undefined;
  const parentWorld = parent ? worldPosition(nodes, parent) : null;
  const originX =
    parent && parentWorld
      ? parentWorld.x + parent.width + CARD_GAP
      : source.x + CARD_WIDTH + CARD_GAP;
  const originY = parentWorld ? parentWorld.y : source.y;
  const windowNode: SessionCanvasNode = {
    ...createCanvasNode(source.sessionId, {
      x: originX,
      y: originY,
    }),
    expanded: true,
    openedFromId: source.id,
    width: DETAIL_CARD_WIDTH,
    height: DETAIL_CARD_HEIGHT,
  };
  return [...nodes, windowNode];
}

function withoutSessionWindows(
  nodes: readonly SessionCanvasNode[],
  sessionId: string,
  keepId?: string
): SessionCanvasNode[] {
  return nodes
    .filter((node) => {
      if (node.id === keepId) return true;
      if (
        !isSessionNode(node) ||
        node.sessionId !== sessionId ||
        !node.expanded
      ) {
        return true;
      }
      return !node.openedFromId;
    })
    .map((node) =>
      node.id !== keepId &&
      isSessionNode(node) &&
      node.sessionId === sessionId &&
      node.expanded
        ? collapseNode(node)
        : node
    );
}

export function openSessionWindow(
  nodes: readonly SessionCanvasNode[],
  cardId: string
): SessionCanvasNode[] {
  const card = nodeById(nodes, cardId);
  if (!card || !isSessionNode(card) || !card.sessionId) return [...nodes];
  if (card.expanded) return [...nodes];

  const existingDetached = nodes.find(
    (node) =>
      isSessionNode(node) &&
      node.expanded &&
      node.sessionId === card.sessionId &&
      Boolean(node.openedFromId)
  );
  if (card.parentId) {
    if (existingDetached) return [...nodes];
    return placeDetachedWindow(
      withoutSessionWindows(nodes, card.sessionId),
      cardId
    );
  }

  return withoutSessionWindows(nodes, card.sessionId, cardId).map((node) =>
    node.id === cardId ? expandNode(node) : node
  );
}

export function isDetachedSessionWindow(node: SessionCanvasNode): boolean {
  return (
    isSessionNode(node) &&
    node.expanded &&
    typeof node.openedFromId === 'string' &&
    node.openedFromId.length > 0
  );
}

export function closeSessionWindow(
  nodes: readonly SessionCanvasNode[],
  instanceId: string
): SessionCanvasNode[] {
  const current = nodeById(nodes, instanceId);
  if (!current || !isSessionNode(current) || !current.expanded) {
    return [...nodes];
  }
  if (isDetachedSessionWindow(current)) {
    return nodes.filter((node) => node.id !== instanceId);
  }
  return nodes.map((node) =>
    node.id === instanceId ? collapseNode(node) : node
  );
}

export function toggleGroupShowAll(
  nodes: readonly SessionCanvasNode[],
  groupId: string
): SessionCanvasNode[] {
  const group = nodeById(nodes, groupId);
  if (!group || !isGroupNode(group)) return [...nodes];
  const next = nodes.map((node) =>
    node.id === groupId ? { ...node, showAll: !node.showAll } : node
  );
  return relayoutGroup(next, groupId);
}

export function renameGroup(
  nodes: readonly SessionCanvasNode[],
  groupId: string,
  name: string
): SessionCanvasNode[] {
  return nodes.map((node) =>
    node.id === groupId
      ? { ...node, name: uniqueGroupName(name, nodes, groupId) }
      : node
  );
}

export function isOverflowHidden(
  nodes: readonly SessionCanvasNode[],
  node: SessionCanvasNode
): boolean {
  if (!node.parentId || isGroupNode(node) || node.expanded) return false;
  const parent = nodeById(nodes, node.parentId);
  if (!parent) return false;
  if (parent.collapsed) return true;
  if (parent.showAll) return false;
  const sessions = directChildren(nodes, parent.id).filter(
    (child) => isSessionNode(child) && !child.expanded
  );
  const plan = planSessionGrid(sessions.length, parent);
  return sessions.findIndex((child) => child.id === node.id) >= plan.visible;
}

export function applyDescendantDelta(
  nodes: readonly SessionCanvasNode[],
  groupId: string,
  dx: number,
  dy: number
): SessionCanvasNode[] {
  if (dx === 0 && dy === 0) return [...nodes];
  return nodes.map((node) =>
    node.id === groupId || belongsToAncestor(nodes, node, groupId)
      ? { ...node, x: node.x + dx, y: node.y + dy }
      : node
  );
}

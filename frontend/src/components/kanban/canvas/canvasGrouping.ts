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

export const GROUP_COLUMNS = 3;
export const GROUP_VISIBLE_LIMIT = 15;
export const GROUP_HEADER_HEIGHT = 32;
export const GROUP_FOOTER_HEIGHT = 32;
export const GROUP_PAD = 12;
export const GROUP_GAP = 12;
export const GROUP_COLLAPSED_HEIGHT = GROUP_HEADER_HEIGHT;
export const DEFAULT_GROUP_COLUMNS = 2;
export const EMPTY_GROUP_COLUMNS = DEFAULT_GROUP_COLUMNS;
export const EMPTY_GROUP_ROWS = 2;
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
  const groups = nodes
    .filter(isGroupNode)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return groups.findIndex((group) => group.id === groupId) + 1;
}

export function directChildren(
  nodes: readonly SessionCanvasNode[],
  parentId: string
): SessionCanvasNode[] {
  return nodes.filter((node) => node.parentId === parentId);
}

export function nodeById(
  nodes: readonly SessionCanvasNode[],
  id: string
): SessionCanvasNode | undefined {
  return nodes.find((node) => node.id === id);
}

export function containingGroupId(node: SessionCanvasNode): string | null {
  return isGroupNode(node) ? node.id : node.parentId;
}

export function groupDepth(
  nodes: readonly SessionCanvasNode[],
  id: string
): number {
  let depth = 0;
  let current = nodeById(nodes, id);
  const seen = new Set<string>();
  while (current?.parentId) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    depth += 1;
    current = nodeById(nodes, current.parentId);
  }
  return depth;
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

export function groupGridSize(
  sessionCount: number,
  showAll = false
): { width: number; height: number; rows: number; visible: number } {
  const columns =
    sessionCount <= 1
      ? DEFAULT_GROUP_COLUMNS
      : Math.min(GROUP_COLUMNS, sessionCount);
  const visible = showAll
    ? sessionCount
    : Math.min(sessionCount, GROUP_VISIBLE_LIMIT);
  const rows = Math.max(1, Math.ceil(visible / columns) || 1);
  const overflow = sessionCount > visible;
  return {
    width: groupWidthForColumns(columns),
    height: groupHeightForRows(rows, overflow),
    rows,
    visible,
  };
}

function replaceNodes(
  nodes: readonly SessionCanvasNode[],
  updates: Map<string, SessionCanvasNode>
): SessionCanvasNode[] {
  return nodes.map((node) => updates.get(node.id) ?? node);
}

export function relayoutGroup(
  nodes: readonly SessionCanvasNode[],
  groupId: string,
  options?: { lockFrame?: boolean }
): SessionCanvasNode[] {
  const group = nodeById(nodes, groupId);
  if (!group || !isGroupNode(group)) return [...nodes];
  if (group.collapsed) {
    return replaceNodes(
      nodes,
      new Map([[group.id, { ...group, height: GROUP_COLLAPSED_HEIGHT }]])
    );
  }

  const nested = directChildren(nodes, groupId).filter(isGroupNode);
  const sessions = directChildren(nodes, groupId).filter(
    (node) => isSessionNode(node) && !node.expanded
  );
  const updates = new Map<string, SessionCanvasNode>();

  let cursorY = GROUP_HEADER_HEIGHT + GROUP_PAD;
  const originX = GROUP_PAD;
  let innerWidth = 0;

  for (const nestedGroup of nested) {
    const laidOut = relayoutGroup(
      replaceNodes(nodes, updates).map((node) =>
        node.id === nestedGroup.id
          ? { ...nestedGroup, x: originX, y: cursorY }
          : node
      ),
      nestedGroup.id
    );
    const nextNested = nodeById(laidOut, nestedGroup.id);
    if (nextNested) {
      updates.set(nextNested.id, nextNested);
      innerWidth = Math.max(innerWidth, nextNested.width);
      cursorY += nextNested.height + GROUP_GAP;
      for (const child of laidOut) {
        if (
          child.parentId === nestedGroup.id ||
          belongsToAncestor(laidOut, child, nestedGroup.id)
        ) {
          updates.set(child.id, child);
        }
      }
    }
  }

  const columns = Math.max(
    columnsForGroupWidth(Math.max(group.width, groupWidthForColumns(1))),
    innerWidth > 0 ? columnsForGroupWidth(innerWidth + GROUP_PAD * 2) : 1
  );
  const declaredRows = rowsForGroupHeight(
    Math.max(group.height, groupHeightForRows(1))
  );
  const cap =
    options?.lockFrame || group.showAll
      ? sessions.length
      : Math.min(sessions.length, declaredRows * columns);
  const shown = group.showAll ? sessions.length : cap;
  const overflow = sessions.length > shown;

  sessions.forEach((session, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    updates.set(session.id, {
      ...session,
      x: originX + col * (CARD_WIDTH + GROUP_GAP),
      y: cursorY + row * (CARD_HEIGHT + GROUP_GAP),
    });
  });

  const sessionRows = Math.max(
    sessions.length === 0 && nested.length === 0 ? declaredRows : 0,
    Math.ceil(shown / columns)
  );
  if (sessionRows > 0) {
    cursorY +=
      sessionRows * CARD_HEIGHT + Math.max(0, sessionRows - 1) * GROUP_GAP;
  }

  const contentHeight =
    cursorY + GROUP_PAD + (overflow ? GROUP_FOOTER_HEIGHT : 0);
  const width = Math.max(
    groupWidthForColumns(columns),
    GROUP_PAD * 2 + innerWidth
  );
  if (!options?.lockFrame) {
    updates.set(group.id, {
      ...group,
      width,
      height: Math.max(
        contentHeight,
        groupHeightForRows(declaredRows, overflow)
      ),
    });
  }

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
  const columns = Math.min(
    GROUP_COLUMNS,
    Math.max(DEFAULT_GROUP_COLUMNS, sessionCount)
  );
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
  return relayoutGroup([group, ...next], group.id);
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

export function attachToGroup(
  nodes: readonly SessionCanvasNode[],
  childId: string,
  groupId: string
): SessionCanvasNode[] {
  const child = nodeById(nodes, childId);
  const group = nodeById(nodes, groupId);
  if (!child || !group || !isGroupNode(group) || child.id === groupId) {
    return [...nodes];
  }
  if (isGroupNode(child)) {
    if (groupDepth(nodes, groupId) !== 0) return [...nodes];
    if (directChildren(nodes, child.id).some(isGroupNode)) return [...nodes];
  } else if (groupDepth(nodes, groupId) >= MAX_GROUP_DEPTH) {
    return [...nodes];
  }
  const previousParent = child.parentId;
  let next = nodes.map((node) =>
    node.id === childId ? { ...node, parentId: groupId } : node
  );
  if (previousParent) next = relayoutGroup(next, previousParent);
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
  for (const node of nodes) {
    if (!isGroupNode(node) || node.id === draggedId || node.collapsed) continue;
    if (dragged.parentId && belongsToAncestor(nodes, node, draggedId)) continue;
    const rect = worldRect(nodes, node);
    if (!contains(rect)) continue;
    if (!groupHit) groupHit = node;
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

export function applyDropHint(
  nodes: readonly SessionCanvasNode[],
  draggedId: string,
  hint: CanvasDropHint
): SessionCanvasNode[] {
  switch (hint.type) {
    case 'same':
      return relayoutGroup(nodes, hint.groupId);
    case 'group':
      return attachToGroup(nodes, draggedId, hint.groupId);
    case 'merge':
      return groupSelection(nodes, new Set([draggedId, hint.targetId]));
    case 'canvas':
      return detachNode(nodes, draggedId, { x: hint.x, y: hint.y });
  }
}

export function previewGroupFrame(
  nodes: readonly SessionCanvasNode[],
  groupId: string,
  geometry: { x: number; y: number; width: number; height: number }
): SessionCanvasNode[] {
  const group = nodeById(nodes, groupId);
  if (!group || !isGroupNode(group) || group.collapsed) return [...nodes];
  const width = Math.max(geometry.width, groupWidthForColumns(1));
  const height = Math.max(geometry.height, groupHeightForRows(1));
  if (
    group.x === geometry.x &&
    group.y === geometry.y &&
    group.width === width &&
    group.height === height
  ) {
    return [...nodes];
  }
  const next = nodes.map((node) =>
    node.id === groupId
      ? { ...node, x: geometry.x, y: geometry.y, width, height }
      : node
  );
  return relayoutGroup(next, groupId, { lockFrame: true });
}

export function resizeGroupFrame(
  nodes: readonly SessionCanvasNode[],
  groupId: string,
  geometry: { x: number; y: number; width: number; height: number }
): SessionCanvasNode[] {
  const group = nodeById(nodes, groupId);
  if (!group || !isGroupNode(group) || group.collapsed) return [...nodes];
  const width = groupWidthForColumns(columnsForGroupWidth(geometry.width));
  const height = groupHeightForRows(rowsForGroupHeight(geometry.height));
  const next = nodes.map((node) =>
    node.id === groupId
      ? { ...node, x: geometry.x, y: geometry.y, width, height }
      : node
  );
  return relayoutAncestors(next, groupId);
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
  const columns = columnsForGroupWidth(
    Math.max(parent.width, groupWidthForColumns(1))
  );
  const cap = Math.min(
    sessions.length,
    rowsForGroupHeight(Math.max(parent.height, groupHeightForRows(1))) * columns
  );
  return sessions.findIndex((child) => child.id === node.id) >= cap;
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

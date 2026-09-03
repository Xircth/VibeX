import { describe, expect, it } from 'vitest';
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  DETAIL_CARD_HEIGHT,
  DETAIL_CARD_WIDTH,
  canvasNodeId,
  createCanvasNode,
} from './canvasModel';
import {
  GROUP_GAP,
  GROUP_HEADER_HEIGHT,
  GROUP_PAD,
  MAX_GROUP_ROWS,
  applyFlowGeometryChanges,
  groupHasRunningSession,
  selectedSessionIdsForViewed,
  applyDropHint,
  buildCanvasFlowLookups,
  CANVAS_DROP_HINT,
  dropHintsEqual,
  attachToGroup,
  canGroupSelection,
  computeDropHint,
  containerMinSize,
  createEmptyGroup,
  detachNode,
  dissolveGroup,
  dragHitRect,
  dropOnTarget,
  emptyGroupFootprint,
  excludeSelectedGroupChildren,
  expandSelectionToGroups,
  findEmptyCanvasPlacement,
  columnsForGroupWidth,
  groupHeightForRows,
  groupNumber,
  groupSelection,
  groupWidthForColumns,
  hitTestNode,
  importSessionsAsGroup,
  isContainerGroup,
  openSessionWindow,
  closeSessionWindow,
  orderCanvasNodes,
  canvasNodeZIndex,
  overlapRatio,
  placeDetachedWindow,
  previewGroupFrame,
  previewCanvasDrop,
  nextOpenCardSlot,
  planSessionGrid,
  resizeGroupFrame,
  rowsForGroupHeight,
  uniqueGroupName,
  worldPosition,
} from './canvasGrouping';

function makeNestedGroup() {
  const innerNodes = groupSelection(
    [
      createCanvasNode('sess-a', { x: 0, y: 0 }, 'a'),
      createCanvasNode('sess-b', { x: 40, y: 0 }, 'b'),
    ],
    new Set(['a', 'b']),
    'Inner'
  );
  const inner = innerNodes.find((node) => node.kind === 'group')!;
  const nested = groupSelection(
    [...innerNodes, createCanvasNode('sess-c', { x: 400, y: 0 }, 'c')],
    new Set([inner.id, 'c']),
    'Outer'
  );
  const outer = nested.find(
    (node) => node.kind === 'group' && node.id !== inner.id
  )!;
  return {
    nodes: nested,
    outer,
    inner: nested.find((node) => node.id === inner.id)!,
  };
}

describe('uniqueGroupName', () => {
  it('adds a numeric suffix when the name is taken', () => {
    const existing = importSessionsAsGroup([], ['a'], 'Codex', { x: 0, y: 0 });
    expect(uniqueGroupName('Codex', existing)).toBe('Codex_1');
  });
});

describe('grouping', () => {
  it('groups two free cards and numbers groups by creation order', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 0 }, 'b');
    const grouped = groupSelection([a, b], new Set(['a', 'b']), 'VibeX');
    const group = grouped.find((node) => node.kind === 'group');
    expect(group?.name).toBe('VibeX');
    expect(grouped.filter((node) => node.parentId === group?.id)).toHaveLength(
      2
    );
    expect(groupNumber(grouped, group!.id)).toBe(1);
    expect(GROUP_HEADER_HEIGHT).toBe(32);
  });

  it('marks a group as running when a member session is in progress', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 0 }, 'b');
    const grouped = groupSelection([a, b], new Set(['a', 'b']), 'G');
    const group = grouped.find((node) => node.kind === 'group')!;
    expect(groupHasRunningSession(grouped, group.id, new Set())).toBe(false);
    expect(groupHasRunningSession(grouped, group.id, new Set(['sess-a']))).toBe(
      true
    );
  });

  it('collects selected session ids without treating groups as viewed', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 0 }, 'b');
    const grouped = groupSelection([a, b], new Set(['a', 'b']), 'G');
    const group = grouped.find((node) => node.kind === 'group')!;
    expect(
      selectedSessionIdsForViewed(grouped, new Set([group.id, 'a']))
    ).toEqual(['sess-a']);
  });

  it('promotes a marquee of grouped cards onto the group without selecting siblings', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 0 }, 'b');
    const grouped = groupSelection([a, b], new Set(['a', 'b']), 'G');
    const group = grouped.find((node) => node.kind === 'group')!;
    const selected = expandSelectionToGroups(grouped, new Set(['a']));
    expect(selected.has(group.id)).toBe(true);
    expect(selected.has('a')).toBe(true);
    expect(selected.has('b')).toBe(false);
  });

  it('keeps a clicked group from selecting its child cards', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 0 }, 'b');
    const grouped = groupSelection([a, b], new Set(['a', 'b']), 'G');
    const group = grouped.find((node) => node.kind === 'group')!;
    const clicked = excludeSelectedGroupChildren(
      grouped,
      new Set([group.id, 'a', 'b'])
    );
    expect(clicked.has(group.id)).toBe(true);
    expect(clicked.has('a')).toBe(false);
    expect(clicked.has('b')).toBe(false);
  });

  it('treats a session window as its card and selects the owning group', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 0 }, 'b');
    const grouped = groupSelection([a, b], new Set(['a', 'b']), 'G');
    const group = grouped.find((node) => node.kind === 'group')!;
    const opened = openSessionWindow(grouped, 'a');
    const windowNode = opened.find((node) => node.expanded)!;
    const selected = expandSelectionToGroups(opened, new Set([windowNode.id]));
    expect(selected.has('a')).toBe(true);
    expect(selected.has(group.id)).toBe(true);
    expect(selected.has('b')).toBe(false);
  });

  it('groups a free card with a group into a nested group', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 0 }, 'b');
    const inner = groupSelection([a, b], new Set(['a', 'b']), 'Inner');
    const innerGroup = inner.find((node) => node.kind === 'group')!;
    const c = createCanvasNode('sess-c', { x: 400, y: 0 }, 'c');
    const nodes = [...inner, c];
    expect(canGroupSelection(nodes, new Set([innerGroup.id, 'c']))).toBe(true);
    const nested = groupSelection(
      nodes,
      new Set([innerGroup.id, 'c']),
      'Outer'
    );
    const outer = nested.find(
      (node) => node.kind === 'group' && node.id !== innerGroup.id
    )!;
    expect(nested.find((node) => node.id === innerGroup.id)?.parentId).toBe(
      outer.id
    );
    expect(nested.find((node) => node.id === 'c')?.parentId).toBe(outer.id);
  });

  it('nests a card and a group into an outer group, and dissolves inward', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 0 }, 'b');
    const inner = groupSelection([a, b], new Set(['a', 'b']), 'Inner');
    const c = createCanvasNode('sess-c', { x: 400, y: 0 }, 'c');
    const innerGroup = inner.find((node) => node.kind === 'group')!;
    const nested = groupSelection(
      [...inner, c],
      new Set([innerGroup.id, 'c']),
      'Outer'
    );
    const outer = nested.find(
      (node) => node.kind === 'group' && node.id !== innerGroup.id
    )!;
    expect(nested.find((node) => node.id === innerGroup.id)?.parentId).toBe(
      outer.id
    );
    expect(nested.find((node) => node.id === 'c')?.parentId).toBe(outer.id);

    const dissolved = dissolveGroup(nested, innerGroup.id);
    expect(dissolved.find((node) => node.id === innerGroup.id)).toBeUndefined();
    expect(dissolved.find((node) => node.id === 'a')?.parentId).toBe(outer.id);
  });

  it('lets nested-group children stay put when the outer frame grows', () => {
    const nested = makeNestedGroup();
    expect(isContainerGroup(nested.nodes, nested.outer.id)).toBe(true);
    const beforeInner = nested.nodes.find(
      (node) => node.id === nested.inner.id
    )!;
    const beforeCard = nested.nodes.find((node) => node.id === 'c')!;
    const grown = resizeGroupFrame(
      nested.nodes,
      nested.outer.id,
      {
        x: nested.outer.x,
        y: nested.outer.y,
        width: nested.outer.width + 240,
        height: nested.outer.height + 160,
      },
      {
        width: nested.outer.width,
        height: nested.outer.height,
        axis: 'xy',
      }
    );
    const outer = grown.find((node) => node.id === nested.outer.id)!;
    expect(outer.width).toBeGreaterThan(nested.outer.width);
    expect(outer.height).toBeGreaterThan(nested.outer.height);
    expect(grown.find((node) => node.id === nested.inner.id)).toMatchObject({
      x: beforeInner.x,
      y: beforeInner.y,
    });
    expect(grown.find((node) => node.id === 'c')).toMatchObject({
      x: beforeCard.x,
      y: beforeCard.y,
    });
  });

  it('keeps a freely moved child inside a nested group instead of re-stacking', () => {
    const nested = makeNestedGroup();
    const grown = resizeGroupFrame(
      nested.nodes,
      nested.outer.id,
      {
        x: nested.outer.x,
        y: nested.outer.y,
        width: nested.outer.width + 280,
        height: nested.outer.height + 80,
      },
      {
        width: nested.outer.width,
        height: nested.outer.height,
        axis: 'xy',
      }
    );
    const inner = grown.find((node) => node.id === nested.inner.id)!;
    const moved = grown.map((node) =>
      node.id === 'c'
        ? {
            ...node,
            x: inner.x + inner.width + 24,
            y: inner.y,
          }
        : node
    );
    const dropped = applyDropHint(moved, 'c', {
      type: 'same',
      groupId: nested.outer.id,
    });
    const card = dropped.find((node) => node.id === 'c')!;
    expect(card.x).toBeGreaterThan(inner.x);
    expect(dropped.find((node) => node.id === nested.inner.id)).toMatchObject({
      x: inner.x,
      y: inner.y,
    });
  });

  it('lets a nested group stay at a free position inside its parent', () => {
    const nested = makeNestedGroup();
    const grown = resizeGroupFrame(
      nested.nodes,
      nested.outer.id,
      {
        x: nested.outer.x,
        y: nested.outer.y,
        width: nested.outer.width + 280,
        height: nested.outer.height + 120,
      },
      {
        width: nested.outer.width,
        height: nested.outer.height,
        axis: 'xy',
      }
    );
    const inner = grown.find((node) => node.id === nested.inner.id)!;
    const moved = grown.map((node) =>
      node.id === nested.inner.id
        ? { ...node, x: inner.x + 48, y: inner.y + 36 }
        : node
    );
    const dropped = applyDropHint(moved, nested.inner.id, {
      type: 'same',
      groupId: nested.outer.id,
    });
    expect(dropped.find((node) => node.id === nested.inner.id)).toMatchObject({
      x: inner.x + 48,
      y: inner.y + 36,
    });
    expect(dropped.find((node) => node.id === 'c')).toMatchObject({
      x: grown.find((node) => node.id === 'c')!.x,
      y: grown.find((node) => node.id === 'c')!.y,
    });
  });

  it('packs nested-group children and grows height when the outer width shrinks', () => {
    const nested = makeNestedGroup();
    const grown = resizeGroupFrame(
      nested.nodes,
      nested.outer.id,
      {
        x: nested.outer.x,
        y: nested.outer.y,
        width: nested.outer.width + 320,
        height: nested.outer.height + 40,
      },
      {
        width: nested.outer.width,
        height: nested.outer.height,
        axis: 'x',
      }
    );
    const inner = grown.find((node) => node.id === nested.inner.id)!;
    const spread = grown.map((node) =>
      node.id === 'c'
        ? { ...node, x: inner.x + inner.width + 24, y: inner.y }
        : node
    );
    const min = containerMinSize(spread, nested.outer.id);
    const hugged = resizeGroupFrame(
      spread,
      nested.outer.id,
      {
        x: nested.outer.x,
        y: nested.outer.y,
        width: spread.find((node) => node.id === nested.outer.id)!.width,
        height: min.height,
      },
      {
        width: spread.find((node) => node.id === nested.outer.id)!.width,
        height: spread.find((node) => node.id === nested.outer.id)!.height,
        axis: 'y',
      }
    );
    const rowHeight = hugged.find(
      (node) => node.id === nested.outer.id
    )!.height;
    const squeezed = resizeGroupFrame(
      hugged,
      nested.outer.id,
      {
        x: nested.outer.x,
        y: nested.outer.y,
        width: min.width,
        height: rowHeight,
      },
      {
        width: hugged.find((node) => node.id === nested.outer.id)!.width,
        height: rowHeight,
        axis: 'x',
      }
    );
    const outer = squeezed.find((node) => node.id === nested.outer.id)!;
    const card = squeezed.find((node) => node.id === 'c')!;
    expect(outer.width).toBe(min.width);
    expect(outer.width).toBeGreaterThanOrEqual(inner.width + GROUP_PAD * 2);
    expect(card.y).toBeGreaterThan(
      squeezed.find((node) => node.id === nested.inner.id)!.y
    );
    expect(outer.height).toBeGreaterThan(rowHeight);
    expect(card.y + CARD_HEIGHT).toBeLessThanOrEqual(outer.height - GROUP_PAD);
  });

  it('cannot shrink a nested group narrower than its widest group child', () => {
    const nested = makeNestedGroup();
    const min = containerMinSize(nested.nodes, nested.outer.id);
    const squeezed = resizeGroupFrame(
      nested.nodes,
      nested.outer.id,
      {
        x: nested.outer.x,
        y: nested.outer.y,
        width: 40,
        height: nested.outer.height,
      },
      {
        width: nested.outer.width,
        height: nested.outer.height,
        axis: 'x',
      }
    );
    const outer = squeezed.find((node) => node.id === nested.outer.id)!;
    expect(outer.width).toBe(min.width);
    expect(min.width).toBeGreaterThanOrEqual(
      nested.inner.width + GROUP_PAD * 2
    );
  });

  it('packs nested-group children and grows width when the outer height shrinks', () => {
    const nested = makeNestedGroup();
    const min = containerMinSize(nested.nodes, nested.outer.id);
    const squeezed = resizeGroupFrame(
      nested.nodes,
      nested.outer.id,
      {
        x: nested.outer.x,
        y: nested.outer.y,
        width: nested.outer.width,
        height: min.height,
      },
      {
        width: nested.outer.width,
        height: nested.outer.height,
        axis: 'y',
      }
    );
    const outer = squeezed.find((node) => node.id === nested.outer.id)!;
    const inner = squeezed.find((node) => node.id === nested.inner.id)!;
    const card = squeezed.find((node) => node.id === 'c')!;
    expect(outer.height).toBe(min.height);
    expect(card.x).toBeGreaterThan(inner.x);
    expect(outer.width).toBeGreaterThanOrEqual(
      inner.width + GROUP_GAP + CARD_WIDTH + GROUP_PAD * 2
    );
    expect(card.x + CARD_WIDTH).toBeLessThanOrEqual(outer.width - GROUP_PAD);
  });

  it('cannot shrink a nested group shorter than its tallest child', () => {
    const nested = makeNestedGroup();
    const min = containerMinSize(nested.nodes, nested.outer.id);
    const squeezed = resizeGroupFrame(
      nested.nodes,
      nested.outer.id,
      {
        x: nested.outer.x,
        y: nested.outer.y,
        width: nested.outer.width,
        height: 20,
      },
      {
        width: nested.outer.width,
        height: nested.outer.height,
        axis: 'y',
      }
    );
    const outer = squeezed.find((node) => node.id === nested.outer.id)!;
    expect(outer.height).toBe(min.height);
    expect(min.height).toBeGreaterThanOrEqual(
      nested.inner.height + GROUP_HEADER_HEIGHT + GROUP_PAD * 2
    );
  });

  it('treats overlapping cards as a drop target even when centers miss', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: CARD_WIDTH / 2, y: 10 }, 'b');
    expect(
      overlapRatio(
        { x: a.x, y: a.y, width: CARD_WIDTH, height: 72 },
        { x: b.x, y: b.y, width: CARD_WIDTH, height: 72 }
      )
    ).toBeGreaterThan(0.2);
    expect(
      hitTestNode(
        [a, b],
        { x: a.x, y: a.y, width: CARD_WIDTH, height: 72 },
        'a'
      )?.id
    ).toBe('b');
  });

  it('creates a blank group with a two-by-two card footprint', () => {
    const next = createEmptyGroup([], { x: 24, y: 48 });
    const group = next.find((node) => node.kind === 'group');
    const footprint = emptyGroupFootprint();
    expect(group?.name).toBe('分组');
    expect(group?.x).toBe(24);
    expect(group?.y).toBe(48);
    expect(group?.width).toBe(footprint.width);
    expect(group?.height).toBe(footprint.height);
    expect(group?.width).toBe(groupWidthForColumns(2));
    expect(group?.height).toBe(groupHeightForRows(2));
    expect(columnsForGroupWidth(group?.width ?? 0)).toBe(2);
    expect(rowsForGroupHeight(group?.height ?? 0)).toBe(2);
  });

  it('places a new group in empty space near the preferred origin', () => {
    const footprint = emptyGroupFootprint();
    const preferred = { x: 0, y: 0 };
    expect(findEmptyCanvasPlacement([], footprint, preferred)).toEqual(
      preferred
    );

    const blocker = createCanvasNode('sess-a', { x: 10, y: 10 }, 'a');
    const placed = findEmptyCanvasPlacement([blocker], footprint, preferred);
    expect(placed).not.toEqual(preferred);
    expect(
      placed.x >= blocker.x + CARD_WIDTH ||
        placed.x + footprint.width <= blocker.x ||
        placed.y >= blocker.y + CARD_HEIGHT ||
        placed.y + footprint.height <= blocker.y
    ).toBe(true);
  });

  it('keeps member cards on the group grid when the group moves', () => {
    const a = createCanvasNode('sess-a', { x: 12, y: 56 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 56 }, 'b');
    const grouped = groupSelection([a, b], new Set(['a', 'b']), 'G');
    const group = grouped.find((node) => node.kind === 'group')!;
    const beforeA = grouped.find((node) => node.id === 'a')!;
    const beforeB = grouped.find((node) => node.id === 'b')!;

    const movedGroup = applyFlowGeometryChanges(grouped, [
      {
        id: canvasNodeId(group.id),
        type: 'position',
        position: { x: group.x + 80, y: group.y + 40 },
        dragging: true,
      },
      {
        id: canvasNodeId('a'),
        type: 'position',
        position: { x: 999, y: 999 },
        dragging: true,
      },
    ]);
    expect(movedGroup.find((node) => node.id === group.id)).toMatchObject({
      x: group.x + 80,
      y: group.y + 40,
    });
    expect(movedGroup.find((node) => node.id === 'a')).toMatchObject({
      x: beforeA.x,
      y: beforeA.y,
    });
    expect(movedGroup.find((node) => node.id === 'b')).toMatchObject({
      x: beforeB.x,
      y: beforeB.y,
    });
    expect(
      worldPosition(movedGroup, movedGroup.find((node) => node.id === 'a')!)
    ).toEqual({
      x: group.x + 80 + beforeA.x,
      y: group.y + 40 + beforeA.y,
    });

    const movedChild = applyFlowGeometryChanges(grouped, [
      {
        id: canvasNodeId('a'),
        type: 'position',
        position: { x: 30, y: 18 },
        dragging: true,
      },
    ]);
    expect(movedChild.find((node) => node.id === group.id)).toMatchObject({
      x: group.x,
      y: group.y,
    });
    expect(movedChild.find((node) => node.id === 'b')).toMatchObject({
      x: beforeB.x,
      y: beforeB.y,
    });
  });

  it('applies live drag and resize geometry before mouseup', () => {
    const card = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const moved = applyFlowGeometryChanges(
      [card],
      [
        {
          id: canvasNodeId('a'),
          type: 'position',
          position: { x: 80, y: 40 },
        },
      ]
    );
    expect(moved.find((node) => node.id === 'a')).toMatchObject({
      x: 80,
      y: 40,
    });

    const windowNode = {
      ...createCanvasNode('sess-b', { x: 10, y: 20 }, 'b'),
      expanded: true,
      width: DETAIL_CARD_WIDTH,
      height: DETAIL_CARD_HEIGHT,
    };
    const resized = applyFlowGeometryChanges(
      [windowNode],
      [
        {
          id: canvasNodeId('b'),
          type: 'dimensions',
          dimensions: { width: 640, height: 500 },
        },
      ]
    );
    expect(resized.find((node) => node.id === 'b')).toMatchObject({
      width: 640,
      height: 500,
    });
  });

  it('collapses an expanded window dropped onto a group and keeps the card in the group', () => {
    const group = createEmptyGroup([], { x: 0, y: 0 }).find(
      (node) => node.kind === 'group'
    )!;
    const windowNode = {
      ...createCanvasNode('sess-a', { x: 20, y: 20 }, 'a'),
      expanded: true,
      width: DETAIL_CARD_WIDTH,
      height: DETAIL_CARD_HEIGHT,
    };
    const next = dropOnTarget([group, windowNode], 'a', group.id);
    const card = next.find((node) => node.id === 'a');
    expect(card?.expanded).toBe(false);
    expect(card?.parentId).toBe(group.id);
    expect(card?.width).toBe(CARD_WIDTH);
    expect(next.find((node) => node.id === group.id)).toBeDefined();
  });

  it('records the source card when opening a detached window', () => {
    const grouped = groupSelection(
      [
        createCanvasNode('sess-a', { x: 0, y: 0 }, 'a'),
        createCanvasNode('sess-b', { x: 40, y: 0 }, 'b'),
      ],
      new Set(['a', 'b']),
      'G'
    );
    const next = placeDetachedWindow(grouped, 'a');
    const windowNode = next.find(
      (node) => node.sessionId === 'sess-a' && node.expanded
    );
    expect(windowNode?.openedFromId).toBe('a');
    expect(next.find((node) => node.id === 'a')?.expanded).toBe(false);
  });

  it('keeps a single window per session and stars cards onto it', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-a', { x: 40, y: 0 }, 'b');
    b.createdAt = a.createdAt + 1;
    const c = createCanvasNode('sess-a', { x: 80, y: 0 }, 'c');
    c.createdAt = a.createdAt + 2;

    const expanded = openSessionWindow([a, b, c], 'a');
    expect(expanded.filter((node) => node.expanded)).toHaveLength(1);
    expect(expanded.find((node) => node.id === 'a')?.expanded).toBe(true);

    const grouped = groupSelection([a, b, c], new Set(['a', 'b']), 'G');
    const groupedA = grouped.find((node) => node.id === 'a')!;
    const opened = openSessionWindow(grouped, groupedA.id);
    const windows = opened.filter((node) => node.expanded);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.openedFromId).toBe('a');
    expect(
      openSessionWindow(opened, groupedA.id).filter((node) => node.expanded)
    ).toHaveLength(1);

    const closed = closeSessionWindow(opened, windows[0]!.id);
    expect(closed.some((node) => node.expanded)).toBe(false);
    expect(closed.find((node) => node.id === 'a')?.expanded).toBe(false);
    expect(closed.filter((node) => node.sessionId === 'sess-a')).toHaveLength(
      grouped.filter((node) => node.sessionId === 'sess-a').length
    );
  });

  it('previews a merge frame when a card is dropped onto another card', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 10 }, 'b');
    const hint = computeDropHint([a, b], 'a', { x: 40, y: 10 });
    expect(hint.type).toBe('merge');
    if (hint.type === 'merge') {
      expect(hint.targetId).toBe('b');
      expect(hint.rect.width).toBeGreaterThan(CARD_WIDTH);
    }
  });

  it('snaps a member back onto its own group grid', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 0 }, 'b');
    const grouped = groupSelection([a, b], new Set(['a', 'b']), 'G');
    const group = grouped.find((node) => node.kind === 'group')!;
    const child = grouped.find((node) => node.id === 'a')!;
    const origin = worldPosition(grouped, group);
    const hint = computeDropHint(grouped, 'a', {
      x: origin.x + child.x + 8,
      y: origin.y + child.y + 8,
    });
    expect(hint).toEqual({ type: 'same', groupId: group.id });
  });

  it('hit-tests expanded windows by their title rect', () => {
    const windowNode = {
      ...createCanvasNode('sess-a', { x: 0, y: 0 }, 'a'),
      expanded: true,
      width: DETAIL_CARD_WIDTH,
      height: DETAIL_CARD_HEIGHT,
    };
    expect(dragHitRect(windowNode, { x: 10, y: 20 })).toEqual({
      x: 10,
      y: 20,
      width: CARD_WIDTH,
      height: 72,
    });
  });

  it('ignores the final mouseup position so parenting is not rewritten in world units', () => {
    const card = createCanvasNode('sess-a', { x: 40, y: 40 }, 'a');
    const next = applyFlowGeometryChanges(
      [card],
      [
        {
          id: canvasNodeId('a'),
          type: 'position',
          position: { x: 400, y: 400 },
          dragging: false,
        },
      ]
    );
    expect(next.find((node) => node.id === 'a')).toMatchObject({
      x: 40,
      y: 40,
    });
  });

  it('drops a card onto another card to create a group, and onto a group to join it', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 0 }, 'b');
    const grouped = dropOnTarget([a, b], 'a', 'b');
    const group = grouped.find((node) => node.kind === 'group')!;
    expect(grouped.findIndex((node) => node.id === group.id)).toBeLessThan(
      grouped.findIndex((node) => node.id === 'a')
    );
    expect(orderCanvasNodes(grouped)[0]?.id).toBe(group.id);
    const c = createCanvasNode('sess-c', { x: 400, y: 0 }, 'c');
    const joined = dropOnTarget([...grouped, c], 'c', group.id);
    expect(joined.find((node) => node.id === 'c')?.parentId).toBe(group.id);
  });

  it('lets the live frame follow the pointer and only snaps on commit', () => {
    const next = createEmptyGroup([], { x: 0, y: 0 });
    const group = next.find((node) => node.kind === 'group')!;
    const geometry = {
      x: 8,
      y: 12,
      width: group.width + 28,
      height: group.height + 18,
    };
    const origin = { width: group.width, height: group.height };
    const previewed = previewGroupFrame(next, group.id, geometry, origin);
    const previewGroup = previewed.find((node) => node.id === group.id)!;
    expect(previewGroup).toMatchObject({
      x: 8,
      y: 12,
      width: group.width + 28,
      height: group.height + 18,
    });

    const committed = resizeGroupFrame(previewed, group.id, geometry, {
      ...origin,
      axis: 'xy',
    });
    expect(committed.find((node) => node.id === group.id)).toMatchObject({
      x: 8,
      y: 12,
      width: groupWidthForColumns(columnsForGroupWidth(group.width + 28)),
    });
  });

  it('reflows member cards as soon as the live frame drops to one column', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 0 }, 'b');
    const grouped = groupSelection([a, b], new Set(['a', 'b']), 'G');
    const group = grouped.find((node) => node.kind === 'group')!;
    expect(columnsForGroupWidth(group.width)).toBeGreaterThan(1);
    expect(grouped.find((node) => node.id === 'b')!.x).toBeGreaterThan(
      grouped.find((node) => node.id === 'a')!.x
    );

    const origin = {
      width: group.width,
      height: group.height,
      axis: 'x' as const,
    };
    const liveWidth = groupWidthForColumns(1) + 40;
    const previewed = previewGroupFrame(
      grouped,
      group.id,
      {
        x: group.x,
        y: group.y,
        width: liveWidth,
        height: group.height,
      },
      origin
    );
    const afterA = previewed.find((node) => node.id === 'a')!;
    const afterB = previewed.find((node) => node.id === 'b')!;
    const previewGroup = previewed.find((node) => node.id === group.id)!;
    expect(previewGroup.width).toBe(liveWidth);
    expect(rowsForGroupHeight(previewGroup.height)).toBe(2);
    expect(afterA.x).toBe(afterB.x);
    expect(afterB.y).toBeGreaterThan(afterA.y);
    expect(afterB.y + CARD_HEIGHT).toBeLessThanOrEqual(
      previewGroup.height - GROUP_PAD
    );
  });

  it('keeps a five-card group at 1x5 after a width squeeze instead of bouncing back', () => {
    const cards = Array.from({ length: 5 }, (_, index) =>
      createCanvasNode(`s${index}`, { x: index * 10, y: 0 }, `n${index}`)
    );
    const grouped = groupSelection(
      cards,
      new Set(cards.map((card) => card.id)),
      'G'
    );
    const group = grouped.find((node) => node.kind === 'group')!;
    expect(columnsForGroupWidth(group.width)).toBe(2);
    expect(rowsForGroupHeight(group.height)).toBe(3);

    const origin = { width: group.width, height: group.height };
    const geometry = {
      x: group.x,
      y: group.y,
      width: groupWidthForColumns(1),
      height: group.height,
    };
    const previewed = previewGroupFrame(grouped, group.id, geometry, origin);
    const live = previewed.find((node) => node.id === group.id)!;
    expect(live.manualColumns).toBe(1);
    expect(live.manualRows).toBeUndefined();
    expect(columnsForGroupWidth(live.width)).toBe(1);
    expect(rowsForGroupHeight(live.height)).toBe(5);

    const stillDragging = previewGroupFrame(
      previewed,
      group.id,
      geometry,
      origin
    );
    const committed = resizeGroupFrame(
      stillDragging,
      group.id,
      geometry,
      origin
    );
    const next = committed.find((node) => node.id === group.id)!;
    expect(next.manualColumns).toBe(1);
    expect(next.manualRows).toBeUndefined();
    expect(columnsForGroupWidth(next.width)).toBe(1);
    expect(rowsForGroupHeight(next.height)).toBe(5);
  });

  it('reflows cards and grows width when the user shortens group height', () => {
    const cards = Array.from({ length: 5 }, (_, index) =>
      createCanvasNode(`s${index}`, { x: index * 10, y: 0 }, `n${index}`)
    );
    const grouped = groupSelection(
      cards,
      new Set(cards.map((card) => card.id)),
      'G'
    );
    const group = grouped.find((node) => node.kind === 'group')!;
    const origin = { width: group.width, height: group.height };
    const geometry = {
      x: group.x,
      y: group.y,
      width: group.width,
      height: groupHeightForRows(1),
    };
    const previewed = previewGroupFrame(grouped, group.id, geometry, origin);
    const live = previewed.find((node) => node.id === group.id)!;
    expect(live.manualRows).toBe(1);
    expect(live.manualColumns).toBeUndefined();
    expect(columnsForGroupWidth(live.width)).toBe(5);
    expect(rowsForGroupHeight(live.height)).toBe(1);

    const committed = resizeGroupFrame(previewed, group.id, geometry, origin);
    const next = committed.find((node) => node.id === group.id)!;
    expect(columnsForGroupWidth(next.width)).toBe(5);
    expect(rowsForGroupHeight(next.height)).toBe(1);
    const first = committed.find((node) => node.id === 'n0')!;
    const last = committed.find((node) => node.id === 'n4')!;
    expect(first.y).toBe(last.y);
    expect(last.x).toBeGreaterThan(first.x);
  });

  it('imports sessions as a new named group and caps the default grid at 20 rows', () => {
    const ids = Array.from({ length: 100 }, (_, index) => `s${index}`);
    const nodes = importSessionsAsGroup([], ids, '最近 7 天', { x: 0, y: 0 });
    const group = nodes.find((node) => node.kind === 'group')!;
    expect(group.name).toBe('最近 7 天');
    expect(nodes.filter((node) => node.parentId === group.id)).toHaveLength(
      100
    );
    expect(columnsForGroupWidth(group.width)).toBe(2);
    expect(rowsForGroupHeight(group.height)).toBe(MAX_GROUP_ROWS);
    expect(planSessionGrid(100, group).overflow).toBe(60);
    expect(GROUP_HEADER_HEIGHT).toBe(32);
  });

  it('does not attach a nested group into another nested group', () => {
    const a = createCanvasNode('a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('b', { x: 10, y: 0 }, 'b');
    const inner = groupSelection([a, b], new Set(['a', 'b']), 'Inner');
    const innerGroup = inner.find((node) => node.kind === 'group')!;
    const c = createCanvasNode('c', { x: 200, y: 0 }, 'c');
    const d = createCanvasNode('d', { x: 220, y: 0 }, 'd');
    const other = groupSelection(
      [...inner, c, d],
      new Set(['c', 'd']),
      'Other'
    );
    const otherGroup = other.find(
      (node) => node.kind === 'group' && node.id !== innerGroup.id
    )!;
    const outer = groupSelection(
      other,
      new Set([innerGroup.id, otherGroup.id]),
      'Outer'
    );
    const outerGroup = outer.find(
      (node) =>
        node.kind === 'group' &&
        node.id !== innerGroup.id &&
        node.id !== otherGroup.id
    )!;
    const refused = attachToGroup(outer, otherGroup.id, innerGroup.id);
    expect(refused.find((node) => node.id === otherGroup.id)?.parentId).toBe(
      outerGroup.id
    );
  });

  it('keeps one group of cards below another group frame when they overlap', () => {
    const grouped = groupSelection(
      groupSelection(
        [
          createCanvasNode('sess-a', { x: 0, y: 0 }, 'a'),
          createCanvasNode('sess-b', { x: 40, y: 0 }, 'b'),
          createCanvasNode('sess-c', { x: 200, y: 0 }, 'c'),
          createCanvasNode('sess-d', { x: 240, y: 0 }, 'd'),
        ],
        new Set(['a', 'b']),
        'Back'
      ),
      new Set(['c', 'd']),
      'Front'
    );
    const front = grouped.find((node) => node.name === 'Front')!;
    const backCard = grouped.find((node) => node.id === 'a')!;
    const frontCard = grouped.find((node) => node.id === 'c')!;

    expect(canvasNodeZIndex(grouped, front)).toBeLessThan(
      canvasNodeZIndex(grouped, frontCard)
    );
    expect(
      canvasNodeZIndex(grouped, backCard, { selectedIds: new Set([front.id]) })
    ).toBeLessThan(
      canvasNodeZIndex(grouped, front, { selectedIds: new Set([front.id]) })
    );

    const lookups = buildCanvasFlowLookups(grouped, {
      selectedIds: new Set([front.id]),
    });
    expect(lookups.zIndex(front)).toBe(
      canvasNodeZIndex(grouped, front, { selectedIds: new Set([front.id]) })
    );
    expect(lookups.groupNumber(front.id)).toBe(groupNumber(grouped, front.id));
  });

  it('treats canvas drop hints as visually equal while merge hints compare geometry', () => {
    expect(
      dropHintsEqual(
        { type: 'canvas', x: 1, y: 2 },
        { type: 'canvas', x: 9, y: 8 }
      )
    ).toBe(true);
    expect(
      dropHintsEqual(CANVAS_DROP_HINT, { type: 'group', groupId: 'g' })
    ).toBe(false);
    expect(
      dropHintsEqual(
        { type: 'group', groupId: 'g' },
        { type: 'group', groupId: 'g' }
      )
    ).toBe(true);
  });

  it('grows an auto group on a two-column grid as cards are dropped in', () => {
    const empty = createEmptyGroup([], { x: 0, y: 0 });
    const group = empty.find((node) => node.kind === 'group')!;
    const first = attachToGroup(
      [...empty, createCanvasNode('s1', { x: 400, y: 0 }, 'a')],
      'a',
      group.id
    );
    expect(
      columnsForGroupWidth(first.find((node) => node.id === group.id)!.width)
    ).toBe(2);
    expect(
      rowsForGroupHeight(first.find((node) => node.id === group.id)!.height)
    ).toBe(1);

    const second = attachToGroup(
      [...first, createCanvasNode('s2', { x: 600, y: 0 }, 'b')],
      'b',
      group.id
    );
    expect(
      rowsForGroupHeight(second.find((node) => node.id === group.id)!.height)
    ).toBe(1);

    const third = attachToGroup(
      [...second, createCanvasNode('s3', { x: 800, y: 0 }, 'c')],
      'c',
      group.id
    );
    expect(
      rowsForGroupHeight(third.find((node) => node.id === group.id)!.height)
    ).toBe(2);

    const fourth = attachToGroup(
      [...third, createCanvasNode('s4', { x: 1000, y: 0 }, 'd')],
      'd',
      group.id
    );
    expect(
      columnsForGroupWidth(fourth.find((node) => node.id === group.id)!.width)
    ).toBe(2);
    expect(
      rowsForGroupHeight(fourth.find((node) => node.id === group.id)!.height)
    ).toBe(2);
  });

  it('locks columns when the user resizes width and grows height to fit', () => {
    const cards = Array.from({ length: 10 }, (_, index) =>
      createCanvasNode(`s${index}`, { x: index * 10, y: 0 }, `n${index}`)
    );
    const grouped = groupSelection(
      cards,
      new Set(cards.map((card) => card.id)),
      'G'
    );
    const group = grouped.find((node) => node.kind === 'group')!;
    const squeezed = resizeGroupFrame(grouped, group.id, {
      x: group.x,
      y: group.y,
      width: groupWidthForColumns(1),
      height: group.height,
    });
    const next = squeezed.find((node) => node.id === group.id)!;
    expect(next.manualColumns).toBe(1);
    expect(next.manualRows).toBeUndefined();
    expect(columnsForGroupWidth(next.width)).toBe(1);
    expect(rowsForGroupHeight(next.height)).toBe(10);
  });

  it('locks rows when the user resizes height and grows width up to 10 columns', () => {
    const cards = Array.from({ length: 15 }, (_, index) =>
      createCanvasNode(`s${index}`, { x: index * 10, y: 0 }, `n${index}`)
    );
    const grouped = groupSelection(
      cards,
      new Set(cards.map((card) => card.id)),
      'G'
    );
    const group = grouped.find((node) => node.kind === 'group')!;
    const oneRow = resizeGroupFrame(grouped, group.id, {
      x: group.x,
      y: group.y,
      width: group.width,
      height: groupHeightForRows(1),
    });
    const next = oneRow.find((node) => node.id === group.id)!;
    expect(next.manualRows).toBe(1);
    expect(columnsForGroupWidth(next.width)).toBe(10);
    expect(rowsForGroupHeight(next.height)).toBe(1);
    expect(planSessionGrid(15, next).overflow).toBe(5);
  });

  it('shows a placeholder slot while dragging a card onto a group', () => {
    const empty = createEmptyGroup([], { x: 0, y: 0 });
    const group = empty.find((node) => node.kind === 'group')!;
    const card = createCanvasNode('s1', { x: 400, y: 0 }, 'a');
    const nodes = [...empty, card];
    const previewed = previewCanvasDrop(nodes, 'a', {
      type: 'group',
      groupId: group.id,
    });
    expect(
      rowsForGroupHeight(previewed.find((node) => node.id === group.id)!.height)
    ).toBe(1);
    expect(nextOpenCardSlot(previewed, group.id)).toEqual({
      x: 12,
      y: GROUP_HEADER_HEIGHT + 12,
    });
  });

  it('resets an emptied group back to the two-by-two footprint', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 0 }, 'b');
    const grouped = groupSelection([a, b], new Set(['a', 'b']), 'G');
    const group = grouped.find((node) => node.kind === 'group')!;
    const locked = resizeGroupFrame(grouped, group.id, {
      x: group.x,
      y: group.y,
      width: groupWidthForColumns(1),
      height: group.height,
    });
    const afterA = detachNode(locked, 'a', { x: 800, y: 0 });
    const emptied = detachNode(afterA, 'b', { x: 1000, y: 0 });
    const empty = emptied.find((node) => node.id === group.id)!;
    expect(empty.manualColumns).toBeUndefined();
    expect(columnsForGroupWidth(empty.width)).toBe(2);
    expect(rowsForGroupHeight(empty.height)).toBe(2);
  });
});

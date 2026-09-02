import { describe, expect, it } from 'vitest';
import {
  CARD_WIDTH,
  DETAIL_CARD_HEIGHT,
  DETAIL_CARD_WIDTH,
  canvasNodeId,
  createCanvasNode,
} from './canvasModel';
import {
  GROUP_VISIBLE_LIMIT,
  applyFlowGeometryChanges,
  attachToGroup,
  computeDropHint,
  createEmptyGroup,
  dissolveGroup,
  dragHitRect,
  dropOnTarget,
  expandSelectionToGroups,
  groupNumber,
  groupSelection,
  hitTestNode,
  importSessionsAsGroup,
  overlapRatio,
  uniqueGroupName,
  worldPosition,
} from './canvasGrouping';

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
  });

  it('treats a partial group marquee as the whole group', () => {
    const a = createCanvasNode('sess-a', { x: 0, y: 0 }, 'a');
    const b = createCanvasNode('sess-b', { x: 40, y: 0 }, 'b');
    const grouped = groupSelection([a, b], new Set(['a', 'b']), 'G');
    const group = grouped.find((node) => node.kind === 'group')!;
    const selected = expandSelectionToGroups(grouped, new Set(['a']));
    expect(selected.has(group.id)).toBe(true);
    expect(selected.has('b')).toBe(true);
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

  it('creates a blank group with a one-row footprint', () => {
    const next = createEmptyGroup([], { x: 24, y: 48 });
    const group = next.find((node) => node.kind === 'group');
    expect(group?.name).toBe('分组');
    expect(group?.x).toBe(24);
    expect(group?.y).toBe(48);
    expect(group?.width).toBeGreaterThan(CARD_WIDTH);
    expect(group?.height).toBeGreaterThan(40);
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
    const c = createCanvasNode('sess-c', { x: 400, y: 0 }, 'c');
    const joined = dropOnTarget([...grouped, c], 'c', group.id);
    expect(joined.find((node) => node.id === 'c')?.parentId).toBe(group.id);
  });

  it('imports sessions as a new named group and caps the default grid at 15', () => {
    const ids = Array.from({ length: 16 }, (_, index) => `s${index}`);
    const nodes = importSessionsAsGroup([], ids, '最近 7 天', { x: 0, y: 0 });
    const group = nodes.find((node) => node.kind === 'group')!;
    expect(group.name).toBe('最近 7 天');
    expect(nodes.filter((node) => node.parentId === group.id)).toHaveLength(16);
    expect(group.width).toBeGreaterThan(CARD_WIDTH * 2);
    expect(GROUP_VISIBLE_LIMIT).toBe(15);
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
});

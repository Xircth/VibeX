import { describe, expect, it } from 'vitest';

import {
  CARD_HEIGHT,
  CARD_WIDTH,
  DETAIL_CARD_HEIGHT,
  DETAIL_CARD_WIDTH,
  DETAIL_MIN_HEIGHT,
  DETAIL_MIN_WIDTH,
  applyMoves,
  collapseNode,
  computeAlignment,
  expandNode,
  filterRecentSessions,
  layoutImportedSessions,
  packLayout,
  parseCanvasNodeId,
  displayedCanvasNodes,
  preferLiveKanbanSessions,
  pruneMissingSessions,
  resetNodeSize,
  resizeNode,
  reuseUnchangedFlowNode,
  sameSessionLinks,
  canvasNodeId,
  openWindowSessionIds,
  canvasWindowSlotIndex,
  type SessionCanvasNode,
} from './canvasModel';

function node(
  sessionId: string,
  x: number,
  y: number,
  expanded = false
): SessionCanvasNode {
  return {
    id: sessionId,
    kind: 'session',
    sessionId,
    parentId: null,
    name: '',
    createdAt: 0,
    showAll: false,
    x,
    y,
    width: expanded ? DETAIL_CARD_WIDTH : CARD_WIDTH,
    height: expanded ? DETAIL_CARD_HEIGHT : CARD_HEIGHT,
    expanded,
  };
}

describe('canvas node ids', () => {
  it('round-trips a session id', () => {
    expect(parseCanvasNodeId(canvasNodeId('abc-1'))).toBe('abc-1');
    expect(parseCanvasNodeId('region-1')).toBeNull();
  });
});

describe('collapsed card size', () => {
  it('is 30% narrower than the original 280px board card', () => {
    expect(CARD_WIDTH).toBe(Math.round(280 * 0.7));
  });
});

describe('reuseUnchangedFlowNode', () => {
  it('keeps the previous object when geometry and selection are unchanged', () => {
    const previous = {
      id: 'session-a',
      type: 'sessionCard',
      selected: false,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      position: { x: 10, y: 20 },
      data: { sessionId: 'a' },
    };
    const next = {
      ...previous,
      position: { x: 10, y: 20 },
      data: { sessionId: 'a' },
    };
    expect(reuseUnchangedFlowNode(previous, next)).toBe(previous);
  });

  it('returns a new object when the node moves or is selected', () => {
    const previous = {
      id: 'session-a',
      type: 'sessionCard',
      selected: false,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      position: { x: 10, y: 20 },
      data: { sessionId: 'a' },
    };
    const moved = reuseUnchangedFlowNode(previous, {
      ...previous,
      position: { x: 40, y: 20 },
    });
    expect(moved).not.toBe(previous);
    expect(moved.data).toBe(previous.data);
    expect(
      reuseUnchangedFlowNode(previous, { ...previous, selected: true })
    ).not.toBe(previous);
  });

  it('does not keep stale group data when only the member count changes', () => {
    const previous = {
      id: 'session-group-1',
      type: 'sessionGroup',
      selected: false,
      width: 400,
      height: 160,
      position: { x: 10, y: 20 },
      data: { instanceId: 'group-1', count: 0, name: '分组' },
    };
    const next = reuseUnchangedFlowNode(previous, {
      ...previous,
      data: { instanceId: 'group-1', count: 2, name: '分组' },
    });
    expect(next.data.count).toBe(2);
    expect(next).not.toBe(previous);
  });
});

describe('expand and collapse', () => {
  it('grows a collapsed card to the detail footprint', () => {
    const expanded = expandNode(node('a', 10, 20));
    expect(expanded.expanded).toBe(true);
    expect(expanded.width).toBe(DETAIL_CARD_WIDTH);
    expect(expanded.height).toBe(DETAIL_CARD_HEIGHT);
    expect(expanded.x).toBe(10);
    expect(expanded.y).toBe(20);
  });

  it('restores the summary footprint on collapse', () => {
    const collapsed = collapseNode(node('a', 10, 20, true));
    expect(collapsed.expanded).toBe(false);
    expect(collapsed.width).toBe(CARD_WIDTH);
    expect(collapsed.height).toBe(CARD_HEIGHT);
  });

  it('keeps position when resizing an expanded card, including from the top-left', () => {
    const resized = resizeNode(node('a', 40, 80, true), {
      x: 10,
      y: 20,
      width: 640,
      height: 480,
    });
    expect(resized).toMatchObject({
      id: 'a',
      sessionId: 'a',
      x: 10,
      y: 20,
      width: 640,
      height: 480,
      expanded: true,
    });
  });

  it('clamps a resize to the expanded minimum and ignores collapsed cards', () => {
    expect(
      resizeNode(node('a', 40, 80, true), {
        x: 8,
        y: 12,
        width: 120,
        height: 80,
      })
    ).toMatchObject({
      x: 8,
      y: 12,
      width: DETAIL_MIN_WIDTH,
      height: DETAIL_MIN_HEIGHT,
    });
    expect(
      resizeNode(node('a', 40, 80), {
        x: 0,
        y: 0,
        width: 640,
        height: 480,
      })
    ).toEqual(node('a', 40, 80));
  });

  it('restores the default expanded size without moving the card', () => {
    const custom = resizeNode(node('a', 40, 80, true), {
      x: 40,
      y: 80,
      width: 900,
      height: 720,
    });
    const reset = resetNodeSize(custom);
    expect(reset.x).toBe(40);
    expect(reset.y).toBe(80);
    expect(reset.width).toBe(DETAIL_CARD_WIDTH);
    expect(reset.height).toBe(DETAIL_CARD_HEIGHT);
    expect(resetNodeSize(node('a', 40, 80))).toEqual(node('a', 40, 80));
  });
});

describe('sameSessionLinks', () => {
  it('draws a dashed pair between two copies of the same session', () => {
    const first = { ...node('sess', 0, 0), id: 'copy-a', createdAt: 1 };
    const second = { ...node('sess', 120, 0), id: 'copy-b', createdAt: 2 };
    const other = node('other', 400, 0);
    expect(sameSessionLinks([first, second, other])).toEqual([
      {
        id: 'same-copy-a-copy-b',
        sourceId: 'copy-a',
        targetId: 'copy-b',
      },
    ]);
    expect(sameSessionLinks([first, other])).toEqual([]);
  });

  it('chains extra copies in the order they were dropped, not as a complete graph', () => {
    const first = { ...node('sess', 0, 0), id: 'copy-a', createdAt: 1 };
    const second = { ...node('sess', 120, 0), id: 'copy-b', createdAt: 2 };
    const third = { ...node('sess', 240, 0), id: 'copy-c', createdAt: 3 };
    expect(sameSessionLinks([third, first, second])).toEqual([
      {
        id: 'same-copy-a-copy-b',
        sourceId: 'copy-a',
        targetId: 'copy-b',
      },
      {
        id: 'same-copy-b-copy-c',
        sourceId: 'copy-b',
        targetId: 'copy-c',
      },
    ]);
  });

  it('stars remaining cards on an in-place expanded window', () => {
    const first = {
      ...node('sess', 0, 0, true),
      id: 'copy-a',
      createdAt: 1,
    };
    const second = { ...node('sess', 120, 0), id: 'copy-b', createdAt: 2 };
    const third = { ...node('sess', 240, 0), id: 'copy-c', createdAt: 3 };
    expect(sameSessionLinks([third, first, second])).toEqual([
      {
        id: 'same-copy-b-copy-a',
        sourceId: 'copy-b',
        targetId: 'copy-a',
      },
      {
        id: 'same-copy-c-copy-a',
        sourceId: 'copy-c',
        targetId: 'copy-a',
      },
    ]);
  });

  it('stars every card onto a detached window, including the grouped source', () => {
    const first = { ...node('sess', 0, 0), id: 'copy-a', createdAt: 1 };
    const second = { ...node('sess', 120, 0), id: 'copy-b', createdAt: 2 };
    const third = { ...node('sess', 240, 0), id: 'copy-c', createdAt: 3 };
    const windowNode = {
      ...node('sess', 400, 0, true),
      id: 'copy-a-window',
      createdAt: 4,
      openedFromId: 'copy-a',
    };
    expect(sameSessionLinks([windowNode, third, first, second])).toEqual([
      {
        id: 'same-copy-a-copy-a-window',
        sourceId: 'copy-a',
        targetId: 'copy-a-window',
      },
      {
        id: 'same-copy-b-copy-a-window',
        sourceId: 'copy-b',
        targetId: 'copy-a-window',
      },
      {
        id: 'same-copy-c-copy-a-window',
        sourceId: 'copy-c',
        targetId: 'copy-a-window',
      },
    ]);
  });
});

describe('open window color slots', () => {
  it('assigns slots in the order windows were opened and ignores collapsed cards', () => {
    const card = { ...node('sess-a', 0, 0), id: 'card', createdAt: 1 };
    const first = {
      ...node('sess-a', 40, 0, true),
      id: 'win-a',
      createdAt: 2,
    };
    const second = {
      ...node('sess-b', 80, 0, true),
      id: 'win-b',
      createdAt: 3,
    };
    const ids = openWindowSessionIds([second, card, first]);
    expect(ids).toEqual(['sess-a', 'sess-b']);
    expect(canvasWindowSlotIndex('sess-a', ids)).toBe(0);
    expect(canvasWindowSlotIndex('sess-b', ids)).toBe(1);
    expect(canvasWindowSlotIndex('sess-c', ids)).toBeNull();
  });
});

describe('computeAlignment', () => {
  it('snaps a moving card to a neighbour edge', () => {
    const moving = {
      id: 'a',
      x: 5,
      y: 0,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    };
    const other = {
      id: 'b',
      x: 0,
      y: 0,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    };
    const result = computeAlignment(moving, [other], 8);
    expect(result.dx).toBe(-5);
    expect(result.guides.some((guide) => guide.axis === 'x')).toBe(true);
  });

  it('returns no correction when nothing is in range', () => {
    const moving = {
      id: 'a',
      x: 400,
      y: 400,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    };
    const other = {
      id: 'b',
      x: 0,
      y: 0,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
    };
    expect(computeAlignment(moving, [other], 6)).toEqual({
      dx: 0,
      dy: 0,
      guides: [],
    });
  });
});

describe('packLayout', () => {
  it('shelves cards left to right and reports only movers', () => {
    const nodes = [node('b', 80, 10), node('a', 0, 0)];
    const moves = packLayout(nodes, { gap: 24, rowWidth: 1000 });
    expect(moves).toEqual([{ id: 'b', x: CARD_WIDTH + 24, y: 0 }]);
    expect(
      applyMoves(nodes, moves).map((item) => [item.sessionId, item.x])
    ).toEqual([
      ['b', CARD_WIDTH + 24],
      ['a', 0],
    ]);
  });
});

describe('filterRecentSessions', () => {
  const now = Date.parse('2026-09-02T12:00:00.000Z');

  it('keeps sessions updated inside the window and drops archived ones', () => {
    const sessions = [
      { id: 'fresh', updatedAt: '2026-09-01T12:00:00.000Z' },
      { id: 'old', updatedAt: '2026-08-01T12:00:00.000Z' },
      {
        id: 'archived',
        updatedAt: '2026-09-01T18:00:00.000Z',
        status: 'archived',
      },
    ];
    expect(
      filterRecentSessions(sessions, 7, now).map((session) => session.id)
    ).toEqual(['fresh']);
  });

  it('orders by recency', () => {
    const sessions = [
      { id: 'older', updatedAt: '2026-09-01T00:00:00.000Z' },
      { id: 'newer', updatedAt: '2026-09-02T00:00:00.000Z' },
    ];
    expect(
      filterRecentSessions(sessions, 7, now).map((session) => session.id)
    ).toEqual(['newer', 'older']);
  });
});

describe('layoutImportedSessions', () => {
  it('skips sessions already on the board and packs the rest', () => {
    const existing = [node('keep', 0, 0)];
    const placed = layoutImportedSessions(['keep', 'a', 'b'], existing);
    expect(placed.map((item) => item.sessionId)).toEqual(['a', 'b']);
    expect(placed[0]).toMatchObject({
      x: 0,
      y: 0,
      expanded: false,
      width: CARD_WIDTH,
    });
    expect(placed[1].x).toBe(CARD_WIDTH + 24);
  });
});

describe('pruneMissingSessions', () => {
  it('drops nodes whose session no longer exists', () => {
    const nodes = [node('live', 0, 0), node('gone', 10, 10)];
    expect(
      pruneMissingSessions(nodes, new Set(['live'])).map(
        (item) => item.sessionId
      )
    ).toEqual(['live']);
  });

  it('keeps empty groups that have no session id', () => {
    const group: SessionCanvasNode = {
      ...node('', 0, 0),
      id: 'group-1',
      kind: 'group',
      name: '分组',
    };
    expect(
      pruneMissingSessions([group, node('gone', 10, 10)], new Set())
    ).toEqual([group]);
  });

  it('does not drop stored cards while no live sessions have loaded', () => {
    const stored = [node('live', 0, 0), node('gone', 10, 10)];
    expect(displayedCanvasNodes(stored, new Set(), false)).toEqual(stored);
    expect(displayedCanvasNodes(stored, new Set(), true)).toEqual(stored);
    expect(
      displayedCanvasNodes(stored, new Set(['live']), true).map(
        (item) => item.sessionId
      )
    ).toEqual(['live']);
  });

  it('keeps the previous live session records across an empty snapshot', () => {
    const previous = [node('live', 0, 0)];
    expect(preferLiveKanbanSessions([], previous)).toEqual(previous);
    expect(preferLiveKanbanSessions([], [])).toEqual([]);
    expect(preferLiveKanbanSessions([node('next', 1, 1)], previous)).toEqual([
      node('next', 1, 1),
    ]);
  });
});

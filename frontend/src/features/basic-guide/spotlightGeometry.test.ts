import { describe, expect, it } from 'vitest';

import {
  calloutKeysFor,
  pairCalloutMoves,
  isCircleLike,
  layoutCallouts,
  mergeOverlapping,
  type CalloutAnchor,
  type MeasuredTarget,
} from './spotlightGeometry';

function anchor(
  key: string,
  rect: { left: number; top: number; width: number; height: number },
  text = key
): CalloutAnchor {
  return { key, text, ...rect };
}

function box(
  id: string,
  copyKey: string,
  rect: { left: number; top: number; width: number; height: number },
  extra?: Partial<MeasuredTarget>
): MeasuredTarget {
  return { id, copyKey, ...rect, ...extra };
}

describe('spotlightGeometry', () => {
  it('merges overlapping create and select rows into one box', () => {
    const merged = mergeOverlapping([
      box(
        'welcome-create-project',
        'select-project-create',
        {
          left: 400,
          top: 180,
          width: 420,
          height: 36,
        },
        { group: 'welcome-start' }
      ),
      box(
        'welcome-select-folder',
        'select-project-create',
        {
          left: 400,
          top: 214,
          width: 420,
          height: 36,
        },
        { group: 'welcome-start' }
      ),
      box('welcome-global-project', 'select-project-global', {
        left: 400,
        top: 320,
        width: 420,
        height: 36,
      }),
    ]);

    expect(merged).toHaveLength(2);
    const start = merged.find((item) =>
      item.sourceIds.includes('welcome-create-project')
    );
    expect(start?.sourceIds).toEqual([
      'welcome-create-project',
      'welcome-select-folder',
    ]);
    expect(start?.copyKeys).toEqual(['select-project-create']);
    expect(start?.height).toBeGreaterThan(50);
    expect(
      merged.some((item) => item.sourceIds.includes('welcome-global-project'))
    ).toBe(true);
  });

  it('draws two lines from a merged box when inner points need separate copy', () => {
    const merged = mergeOverlapping([
      box(
        'a',
        'copy-a',
        { left: 100, top: 100, width: 200, height: 40 },
        {
          group: 'pair',
        }
      ),
      box(
        'b',
        'copy-b',
        { left: 100, top: 136, width: 200, height: 40 },
        {
          group: 'pair',
        }
      ),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.copyKeys).toEqual(['copy-a', 'copy-b']);

    const plan = layoutCallouts({
      boxes: merged,
      callouts: [
        { key: 'copy-a', text: '说明甲' },
        { key: 'copy-b', text: '说明乙' },
      ],
      panel: { left: 16, top: 200, width: 220, height: 180 },
      viewport: { width: 1280, height: 800 },
    });
    expect(plan.callouts).toHaveLength(2);
    expect(plan.connectors).toHaveLength(2);
    expect(plan.connectors.map((line) => line.copyKey).sort()).toEqual([
      'copy-a',
      'copy-b',
    ]);
  });

  it('connects each box to a shared explanation with its own line', () => {
    const merged = mergeOverlapping([
      box('left', 'shared', { left: 300, top: 80, width: 80, height: 32 }),
      box('right', 'shared', { left: 700, top: 80, width: 80, height: 32 }),
    ]);
    expect(merged).toHaveLength(2);
    const plan = layoutCallouts({
      boxes: merged,
      callouts: [{ key: 'shared', text: '同一说明' }],
      panel: { left: 16, top: 200, width: 220, height: 180 },
      viewport: { width: 1280, height: 800 },
    });
    expect(plan.callouts).toHaveLength(1);
    expect(plan.connectors).toHaveLength(2);
  });

  it('uses a circle for compact square icon buttons', () => {
    expect(isCircleLike({ left: 0, top: 0, width: 28, height: 28 })).toBe(true);
    expect(isCircleLike({ left: 0, top: 0, width: 400, height: 36 })).toBe(
      false
    );
    const [circle] = mergeOverlapping([
      box(
        'toolbar-new-session',
        'click-new-session',
        {
          left: 900,
          top: 12,
          width: 28,
          height: 28,
        },
        { shape: 'circle' }
      ),
    ]);
    expect(circle?.shape).toBe('circle');
    expect(circle?.width).toBe(28);
    expect(circle?.height).toBe(28);
    expect(circle?.left).toBe(900);
    expect(circle?.top).toBe(12);
  });

  it('keeps a nested compact control as its own circle inside a larger box', () => {
    const merged = mergeOverlapping([
      box('kanban-session-list', 'kanban-create-session', {
        left: 40,
        top: 80,
        width: 280,
        height: 520,
      }),
      box(
        'kanban-session-list-new',
        '',
        {
          left: 270,
          top: 92,
          width: 28,
          height: 28,
        },
        { shape: 'circle' }
      ),
    ]);
    expect(merged).toHaveLength(2);
    const plus = merged.find((item) =>
      item.sourceIds.includes('kanban-session-list-new')
    );
    expect(plus?.shape).toBe('circle');
    expect(plus?.width).toBe(28);
    expect(plus?.copyKeys).toEqual([]);

    const plan = layoutCallouts({
      boxes: merged,
      callouts: [
        {
          key: 'kanban-create-session',
          text: '点击会话列表上的「+」，再新建一个会话。',
        },
      ],
      panel: { left: 16, top: 400, width: 220, height: 180 },
      viewport: { width: 1280, height: 800 },
    });
    expect(plan.callouts).toHaveLength(1);
    expect(plan.connectors).toHaveLength(1);
    expect(plan.connectors[0]?.copyKey).toBe('kanban-create-session');
  });

  it('places callouts without overlapping each other or the boxes', () => {
    const boxes = mergeOverlapping([
      box('welcome-create-project', 'select-project-create', {
        left: 380,
        top: 170,
        width: 440,
        height: 80,
      }),
      box('welcome-global-project', 'select-project-global', {
        left: 380,
        top: 320,
        width: 440,
        height: 36,
      }),
    ]);
    const plan = layoutCallouts({
      boxes,
      callouts: [
        {
          key: 'select-project-create',
          text: '在 VibeX 中，需要先创建或选择一个项目以继续，项目就是一个文件夹',
        },
        {
          key: 'select-project-global',
          text: '全局则是您的用户文件夹，您可以直接点击全局以继续',
        },
      ],
      panel: { left: 16, top: 260, width: 220, height: 220 },
      viewport: { width: 1280, height: 800 },
    });
    expect(plan.callouts).toHaveLength(2);
    const [first, second] = plan.callouts;
    const gapX = Math.max(
      0,
      first!.left - (second!.left + second!.width),
      second!.left - (first!.left + first!.width)
    );
    const gapY = Math.max(
      0,
      first!.top - (second!.top + second!.height),
      second!.top - (first!.top + first!.height)
    );
    expect(gapX > 0 || gapY > 0).toBe(true);
    for (const callout of plan.callouts) {
      for (const spotlight of boxes) {
        const overlapX =
          Math.min(
            callout.left + callout.width,
            spotlight.left + spotlight.width
          ) - Math.max(callout.left, spotlight.left);
        const overlapY =
          Math.min(
            callout.top + callout.height,
            spotlight.top + spotlight.height
          ) - Math.max(callout.top, spotlight.top);
        expect(overlapX <= 0 || overlapY <= 0).toBe(true);
      }
    }
  });

  it('does not expose copy keys until a box is measured on this window', () => {
    expect(calloutKeysFor([])).toEqual([]);
  });

  it('returns copy keys from measured boxes only', () => {
    expect(
      calloutKeysFor([
        {
          left: 40,
          top: 80,
          width: 200,
          height: 36,
          shape: 'rect',
          sourceIds: ['welcome-create-project'],
          copyKeys: ['select-project-create'],
        },
      ])
    ).toEqual(['select-project-create']);
  });
});

describe('pairCalloutMoves', () => {
  const a1 = anchor('a1', { left: 40, top: 80, width: 160, height: 48 });
  const a2 = anchor('a2', { left: 40, top: 200, width: 160, height: 48 });
  const b1 = anchor('b1', { left: 500, top: 40, width: 180, height: 52 });
  const b2 = anchor('b2', { left: 500, top: 240, width: 180, height: 52 });

  it('pairs two callouts 1-to-1 in shuffled order', () => {
    const plan = pairCalloutMoves([a1, a2], [b1, b2], () => 0);
    expect(plan.moves).toHaveLength(2);
    expect(plan.appear).toEqual([]);
    expect(plan.disappear).toEqual([]);
    expect(new Set(plan.moves.map((move) => move.from.key))).toEqual(
      new Set(['a1', 'a2'])
    );
    expect(new Set(plan.moves.map((move) => move.to.key))).toEqual(
      new Set(['b1', 'b2'])
    );
  });

  it('moves a single callout to one random next callout', () => {
    const swapped = pairCalloutMoves([a1], [b1, b2], () => 0);
    expect(swapped.moves).toEqual([{ from: a1, to: b2 }]);
    expect(swapped.appear).toEqual([b1]);
    expect(swapped.disappear).toEqual([]);

    const identity = pairCalloutMoves([a1], [b1, b2], () => 0.99);
    expect(identity.moves).toEqual([{ from: a1, to: b1 }]);
    expect(identity.appear).toEqual([b2]);
  });

  it('moves one of two previous callouts onto a single next callout', () => {
    const plan = pairCalloutMoves([a1, a2], [b1], () => 0);
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]?.to).toEqual(b1);
    expect(plan.appear).toEqual([]);
    expect(plan.disappear).toHaveLength(1);
    expect(plan.disappear[0]?.key).not.toBe(plan.moves[0]?.from.key);
  });

  it('fades in all callouts when nothing was on screen', () => {
    expect(pairCalloutMoves([], [b1, b2])).toEqual({
      moves: [],
      appear: [b1, b2],
      disappear: [],
    });
  });
});

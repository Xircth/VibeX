import { describe, expect, it } from 'vitest';
import type { TimelineRow } from 'shared/types';
import {
  TIMELINE_OLDER_PAGE_SIZE,
  mergeOpenTimelineRows,
  nextOlderTimelinePage,
  preferLoadedOlderCursor,
} from './timelinePaging';

describe('nextOlderTimelinePage', () => {
  it('returns null when there is no earlier window', () => {
    expect(nextOlderTimelinePage(null)).toBeNull();
    expect(nextOlderTimelinePage(undefined)).toBeNull();
    expect(nextOlderTimelinePage('')).toBeNull();
    expect(nextOlderTimelinePage('   ')).toBeNull();
  });

  it('forwards opaque keyset cursors verbatim with TIMELINE_OLDER_PAGE_SIZE', () => {
    expect(TIMELINE_OLDER_PAGE_SIZE).toBe(120);
    expect(nextOlderTimelinePage('eyJzb3J0X2luZGV4IjoxMjB9')).toEqual({
      cursor: 'eyJzb3J0X2luZGV4IjoxMjB9',
      limit: 120,
    });
    expect(nextOlderTimelinePage('200')).toEqual({ cursor: '200', limit: 120 });
  });
});

describe('preferLoadedOlderCursor', () => {
  it('uses the open-window cursor on first hydrate', () => {
    expect(preferLoadedOlderCursor(null, 'cursor-open-tail', false)).toBe(
      'cursor-open-tail'
    );
  });

  it('keeps a completed loaded window across a tail reload', () => {
    expect(preferLoadedOlderCursor(null, 'cursor-open-tail', true)).toBeNull();
  });

  it('keeps the loaded opaque cursor when the tail reload is behind', () => {
    expect(
      preferLoadedOlderCursor('cursor-page-2', 'cursor-open-tail', true)
    ).toBe('cursor-page-2');
  });
});

function row(id: string, revision: bigint): TimelineRow {
  return {
    row_id: `${id}:user`,
    revision,
    row: {
      kind: 'message_turn',
      phase: 'persisted',
      turn: {
        id: `${id}:user`,
        role: 'user',
        blocks: [{ type: 'text', text: id }],
        timestamp: '2026-07-03T00:00:00.000Z',
      },
    },
  };
}

describe('mergeOpenTimelineRows', () => {
  it('keeps earlier paged rows when the open path only returns the tail', () => {
    const merged = mergeOpenTimelineRows(
      [row('t0', 1n), row('t9', 9n)],
      [row('t9', 9n)]
    );
    expect(merged.map((item) => item.row_id)).toEqual(['t0:user', 't9:user']);
  });

  it('keeps the higher revision when the same row is reloaded', () => {
    const merged = mergeOpenTimelineRows([row('t9', 9n)], [row('t9', 12n)]);
    expect(merged[0]?.revision).toBe(12n);
  });

  it('enforces monotonic revision strictly without special-casing acp-* row_ids', () => {
    const existingRow: TimelineRow = {
      ...row('t1', 10n),
      row_id: 'acp-1',
    };
    const staleIncomingRow: TimelineRow = {
      ...row('t1', 5n),
      row_id: 'acp-1',
    };
    const merged = mergeOpenTimelineRows([existingRow], [staleIncomingRow]);
    expect(merged[0]?.revision).toBe(10n);
  });

  it('appends incoming rows that are newer than the loaded window', () => {
    const merged = mergeOpenTimelineRows(
      [row('t0', 1n), row('t9', 9n)],
      [row('t9', 9n), row('t10', 10n)]
    );
    expect(merged.map((item) => item.row_id)).toEqual([
      't0:user',
      't9:user',
      't10:user',
    ]);
  });

  it('appends a higher-revision row that the snapshot listed before the shared anchor', () => {
    const merged = mergeOpenTimelineRows(
      [row('t0', 1n), row('t9', 9n)],
      [row('t10', 10n), row('t0', 1n), row('t9', 9n)]
    );
    expect(merged.map((item) => item.row_id)).toEqual([
      't0:user',
      't9:user',
      't10:user',
    ]);
  });

  it('still prepends an older row listed before the shared anchor', () => {
    const merged = mergeOpenTimelineRows(
      [row('t9', 9n)],
      [row('t0', 1n), row('t9', 9n)]
    );
    expect(merged.map((item) => item.row_id)).toEqual(['t0:user', 't9:user']);
  });

  it('places newer incoming rows after existing rows by relative anchor index even when existing[0] has a higher cross-namespace revision', () => {
    const merged = mergeOpenTimelineRows(
      [row('t0', 500n), row('t9', 9n)],
      [row('t9', 9n), row('t10', 10n)]
    );
    expect(merged.map((item) => item.row_id)).toEqual([
      't0:user',
      't9:user',
      't10:user',
    ]);
  });
});

describe('computeAnchoredTimelineStartIndex', () => {
  it('freezes the top visible start index while scrolled away from bottom and snaps back when following tail', async () => {
    const { computeAnchoredTimelineStartIndex } = await import(
      './timelinePaging'
    );

    // Following tail: 40 total items, tail window 24 -> start index 16
    const initial = computeAnchoredTimelineStartIndex({
      totalItems: 40,
      visibleTailCount: 24,
      followTail: true,
      anchoredStartIndex: null,
    });
    expect(initial).toBe(16);

    // User scrolls up (!followTail) while 5 new streaming rows arrive at bottom -> stays anchored at 16!
    const whileReadingHistory = computeAnchoredTimelineStartIndex({
      totalItems: 45,
      visibleTailCount: 24,
      followTail: false,
      anchoredStartIndex: initial,
    });
    expect(whileReadingHistory).toBe(16);

    // User clicks/triggers loadEarlierTimeline (visibleTailCount grows to 48) -> ratchets downward to 0
    const afterRevealEarlier = computeAnchoredTimelineStartIndex({
      totalItems: 45,
      visibleTailCount: 48,
      followTail: false,
      anchoredStartIndex: whileReadingHistory,
    });
    expect(afterRevealEarlier).toBe(0);

    // User returns to bottom (followTail = true) with 60 items and tail count 24 -> snaps back to 36
    expect(
      computeAnchoredTimelineStartIndex({
        totalItems: 60,
        visibleTailCount: 24,
        followTail: true,
        anchoredStartIndex: 16,
      })
    ).toBe(36);
  });

  it('keeps an in-flight turn that sits above the short tail while following', async () => {
    const { computeAnchoredTimelineStartIndex } = await import(
      './timelinePaging'
    );
    expect(
      computeAnchoredTimelineStartIndex({
        totalItems: 40,
        visibleTailCount: 24,
        followTail: true,
        anchoredStartIndex: null,
        requiredIndex: 10,
      })
    ).toBe(10);
    expect(
      computeAnchoredTimelineStartIndex({
        totalItems: 40,
        visibleTailCount: 24,
        followTail: true,
        anchoredStartIndex: null,
        requiredIndex: 30,
      })
    ).toBe(16);
    expect(
      computeAnchoredTimelineStartIndex({
        totalItems: 40,
        visibleTailCount: 24,
        followTail: false,
        anchoredStartIndex: 16,
        requiredIndex: 10,
      })
    ).toBe(16);
  });
});

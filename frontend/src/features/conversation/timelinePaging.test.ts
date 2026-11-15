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

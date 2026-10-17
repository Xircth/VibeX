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
    expect(nextOlderTimelinePage('0')).toBeNull();
    expect(nextOlderTimelinePage('nope')).toBeNull();
  });

  it('pages backward in small chunks instead of the whole remaining history', () => {
    expect(TIMELINE_OLDER_PAGE_SIZE).toBe(16);
    expect(nextOlderTimelinePage('80')).toEqual({ start: 64, limit: 16 });
    expect(nextOlderTimelinePage('16')).toEqual({ start: 0, limit: 16 });
    expect(nextOlderTimelinePage('10')).toEqual({ start: 0, limit: 10 });
  });
});

describe('preferLoadedOlderCursor', () => {
  it('uses the open-window cursor on first hydrate', () => {
    expect(preferLoadedOlderCursor(null, '80', false)).toBe('80');
  });

  it('keeps a completed loaded window across a tail reload', () => {
    expect(preferLoadedOlderCursor(null, '80', true)).toBeNull();
  });

  it('keeps the more-complete cursor when the tail reload is behind', () => {
    expect(preferLoadedOlderCursor('16', '80', true)).toBe('16');
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
});

import { describe, expect, it } from 'vitest';
import {
  TIMELINE_OLDER_PAGE_SIZE,
  nextOlderTimelinePage,
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

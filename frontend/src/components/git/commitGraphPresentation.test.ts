import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COMMIT_GRAPH_LABELS,
  formatCommitTimeAgo,
} from './commitGraphPresentation';

describe('commit graph presentation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses readable graph labels', () => {
    expect(COMMIT_GRAPH_LABELS.title).toBe('\u63d0\u4ea4\u56fe');
    expect(COMMIT_GRAPH_LABELS.loading).toBe(
      '\u52a0\u8f7d\u63d0\u4ea4\u56fe...'
    );
  });

  it('formats recent commit timestamps as relative Chinese text', () => {
    vi.setSystemTime(new Date('2026-05-26T08:00:00Z'));
    const now = Math.floor(Date.now() / 1000);

    expect(formatCommitTimeAgo(now - 30)).toBe('30\u79d2\u524d');
    expect(formatCommitTimeAgo(now - 5 * 60)).toBe('5\u5206\u949f\u524d');
    expect(formatCommitTimeAgo(now - 3 * 60 * 60)).toBe('3\u5c0f\u65f6\u524d');
    expect(formatCommitTimeAgo(now - 2 * 24 * 60 * 60)).toBe('2\u5929\u524d');
  });

  it('formats older commit timestamps as dates', () => {
    vi.setSystemTime(new Date('2026-05-26T08:00:00Z'));

    expect(formatCommitTimeAgo(Date.parse('2026-05-01T00:00:00Z') / 1000)).toBe(
      new Date('2026-05-01T00:00:00Z').toLocaleDateString()
    );
  });
});

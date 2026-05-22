import { describe, expect, it } from 'vitest';
import { parseDiffStats } from './diffStatsParser';

describe('parseDiffStats', () => {
  it('counts simplified Codex patches without file headers', () => {
    expect(parseDiffStats('@@\n-old\n+new')).toEqual({
      additions: 1,
      deletions: 1,
    });
  });

  it('ignores unified diff file header lines', () => {
    expect(
      parseDiffStats('--- a/file.ts\n+++ b/file.ts\n@@\n-old\n+new\n+more')
    ).toEqual({
      additions: 2,
      deletions: 1,
    });
  });
});

import { describe, expect, it } from 'vitest';
import type { Diff } from 'shared/types';
import {
  diffNeedsBaseSnapshot,
  generatedDiffDropsDeletions,
  headerChangeCounts,
  streamContentsAreUsable,
} from './diffCardContent';

function diff(overrides: Partial<Diff> = {}): Diff {
  return {
    change: 'modified',
    oldPath: 'src/a.ts',
    newPath: 'src/a.ts',
    oldContent: 'old\n',
    newContent: 'new\n',
    contentOmitted: false,
    additions: 160,
    deletions: 140,
    repoId: 'repo-1',
    ...overrides,
  };
}

describe('diff card content', () => {
  it('trusts a stream that still has both sides', () => {
    expect(streamContentsAreUsable(diff())).toBe(true);
    expect(generatedDiffDropsDeletions(140, 0, true)).toBe(false);
  });

  it('does not treat an omitted or emptied payload as the file body', () => {
    expect(streamContentsAreUsable(diff({ contentOmitted: true }))).toBe(false);
    expect(
      streamContentsAreUsable(diff({ oldContent: null, newContent: null }))
    ).toBe(false);
    expect(
      streamContentsAreUsable(diff({ oldContent: '', newContent: '' }))
    ).toBe(false);
  });

  it('refuses a rebuilt diff that drops deletions git already counted', () => {
    expect(generatedDiffDropsDeletions(140, 0, false)).toBe(true);
    expect(generatedDiffDropsDeletions(140, 140, false)).toBe(false);
    expect(generatedDiffDropsDeletions(0, 0, false)).toBe(false);
  });

  it('keeps the git line counts on the header', () => {
    expect(
      headerChangeCounts(diff(), { additions: 160, deletions: 0 })
    ).toEqual({ additions: 160, deletions: 140 });
  });

  it('loads a base snapshot for every change that still has an old side', () => {
    expect(diffNeedsBaseSnapshot('modified')).toBe(true);
    expect(diffNeedsBaseSnapshot('deleted')).toBe(true);
    expect(diffNeedsBaseSnapshot('added')).toBe(false);
  });
});

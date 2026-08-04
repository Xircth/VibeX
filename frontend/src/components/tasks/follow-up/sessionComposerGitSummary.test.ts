import { describe, expect, it } from 'vitest';
import {
  getChangedFileCount,
  shouldShowChangedFileSummary,
  getSummaryRepoId,
} from './sessionComposerGitSummary';

describe('session composer git summary helpers', () => {
  it('selects the explicit repo only when it is present', () => {
    const repos = [{ id: 'repo-a' }, { id: 'repo-b' }];

    expect(getSummaryRepoId('repo-b', repos)).toBe('repo-b');
    expect(getSummaryRepoId('missing', repos)).toBe('repo-a');
    expect(getSummaryRepoId(null, repos)).toBe('repo-a');
    expect(getSummaryRepoId('repo-a', [])).toBeNull();
  });

  it('counts changed paths once across staged and unstaged files', () => {
    expect(
      getChangedFileCount({
        stagedFiles: [{ path: 'src/a.ts' }, { path: 'src/shared.ts' }],
        unstagedFiles: [{ path: 'src/shared.ts' }, { path: 'src/b.ts' }],
      })
    ).toBe(3);

    expect(
      getChangedFileCount({
        stagedFiles: [],
        unstagedFiles: [],
      })
    ).toBe(0);
  });

  it('shows the changed-file summary only for positive file counts', () => {
    expect(shouldShowChangedFileSummary(1)).toBe(true);
    expect(shouldShowChangedFileSummary(0)).toBe(false);
  });
});

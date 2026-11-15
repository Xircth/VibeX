import { describe, expect, it } from 'vitest';
import { getSummaryRepoId } from './sessionComposerGitSummary';

describe('session composer git summary helpers', () => {
  it('selects the explicit repo only when it is present', () => {
    const repos = [{ id: 'repo-a' }, { id: 'repo-b' }];

    expect(getSummaryRepoId('repo-b', repos)).toBe('repo-b');
    expect(getSummaryRepoId('missing', repos)).toBe('repo-a');
    expect(getSummaryRepoId(null, repos)).toBe('repo-a');
    expect(getSummaryRepoId('repo-a', [])).toBeNull();
  });
});

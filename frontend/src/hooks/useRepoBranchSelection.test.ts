import { describe, expect, it } from 'vitest';
import {
  isGitInitIncomplete,
  repoBranchesRefetchInterval,
  repoBranchesStaleTime,
} from './useRepoBranchSelection';

const EMPTY_CONFIG = {
  repoId: 'repo-1',
  repoDisplayName: 'demo',
  targetBranch: null,
  branches: [],
};

const READY_CONFIG = {
  ...EMPTY_CONFIG,
  targetBranch: 'main',
  branches: [
    {
      name: 'main',
      is_current: true,
      is_remote: false,
      is_worktree: false,
      worktree_path: null,
      last_commit_date: new Date('2026-09-02T00:00:00Z'),
    },
  ],
};

describe('isGitInitIncomplete', () => {
  it('is true after branches settle empty for an existing repo', () => {
    expect(
      isGitInitIncomplete({
        repoCount: 1,
        configs: [EMPTY_CONFIG],
        isLoading: false,
      })
    ).toBe(true);
  });

  it('is false while the first branch fetch is still in flight', () => {
    expect(
      isGitInitIncomplete({
        repoCount: 1,
        configs: [EMPTY_CONFIG],
        isLoading: true,
      })
    ).toBe(false);
  });

  it('is false when every repo already has a branch', () => {
    expect(
      isGitInitIncomplete({
        repoCount: 1,
        configs: [READY_CONFIG],
        isLoading: false,
      })
    ).toBe(false);
  });

  it('is false before any repo is available', () => {
    expect(
      isGitInitIncomplete({
        repoCount: 0,
        configs: [],
        isLoading: false,
      })
    ).toBe(false);
  });
});

describe('repo branch query freshness', () => {
  it('does not treat an empty branch list as fresh', () => {
    expect(repoBranchesStaleTime({ state: { data: [] } })).toBe(0);
    expect(repoBranchesStaleTime({ state: { data: undefined } })).toBe(0);
  });

  it('keeps a populated branch list cached', () => {
    expect(
      repoBranchesStaleTime({ state: { data: READY_CONFIG.branches } })
    ).toBe(60_000);
  });

  it('polls while git has not produced a branch yet', () => {
    expect(
      repoBranchesRefetchInterval({ state: { status: 'success', data: [] } })
    ).toBe(1500);
    expect(
      repoBranchesRefetchInterval({
        state: { status: 'error', data: undefined },
      })
    ).toBe(1500);
    expect(
      repoBranchesRefetchInterval({
        state: { status: 'success', data: READY_CONFIG.branches },
      })
    ).toBe(false);
  });
});

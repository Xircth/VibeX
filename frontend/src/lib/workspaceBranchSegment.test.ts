import { describe, expect, it } from 'vitest';
import type { GitBranch } from 'shared/types';
import {
  buildBranchSegment,
  orderWorkspacesForSelector,
} from './workspaceBranchSegment';

const now = new Date('2026-10-24T00:00:00.000Z');

function branch(overrides: Partial<GitBranch>): GitBranch {
  return {
    name: 'dev',
    is_current: false,
    is_remote: false,
    is_worktree: false,
    worktree_path: null,
    last_commit_date: now,
    ...overrides,
  };
}

describe('orderWorkspacesForSelector', () => {
  it('keeps the project directory ahead of worktrees', () => {
    const ordered = orderWorkspacesForSelector([
      { id: 'wt', use_worktree: true },
      { id: 'root', use_worktree: false },
      { id: 'wt-2', use_worktree: true },
    ]);

    expect(ordered.map((workspace) => workspace.id)).toEqual([
      'root',
      'wt',
      'wt-2',
    ]);
  });
});

describe('buildBranchSegment', () => {
  it('lists checkout targets in the project directory with the current branch first', () => {
    const entries = buildBranchSegment({
      branches: [
        branch({ name: 'feat/other' }),
        branch({ name: 'dev', is_current: true }),
        branch({
          name: 'feat/worktree',
          is_worktree: true,
          worktree_path: 'C:\\wt',
        }),
        branch({ name: 'origin/dev', is_remote: true }),
      ],
      inWorktree: false,
      currentDirectoryBranch: 'dev',
      mainDirectoryBranch: 'dev',
      projectRootWorkspaceId: 'root',
    });

    expect(entries).toEqual([
      { name: 'dev', role: 'current', workspaceId: null },
      { name: 'feat/other', role: 'available', workspaceId: null },
    ]);
  });

  it('pins the main directory branch first after opening a worktree', () => {
    const entries = buildBranchSegment({
      branches: [
        branch({ name: 'dev', is_current: true }),
        branch({
          name: 'feat/next',
          is_worktree: true,
          worktree_path: 'C:\\wt\\feat-next',
        }),
        branch({
          name: 'feat/other-wt',
          is_worktree: true,
          worktree_path: 'C:\\wt\\other',
        }),
        branch({ name: 'free/local' }),
      ],
      inWorktree: true,
      currentDirectoryBranch: 'feat/next',
      mainDirectoryBranch: 'dev',
      projectRootWorkspaceId: 'root',
    });

    expect(entries).toEqual([
      { name: 'dev', role: 'main-directory', workspaceId: 'root' },
      { name: 'feat/next', role: 'current', workspaceId: null },
      { name: 'free/local', role: 'available', workspaceId: null },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  deriveWorkspaceRootPath,
  deriveWorkspaceRootPathCandidates,
} from './workspaceRootPath';

describe('deriveWorkspaceRootPath', () => {
  it('keeps worktree root at container_ref', () => {
    expect(
      deriveWorkspaceRootPath(
        {
          container_ref:
            'C:\\Users\\Administrator\\Documents\\Project\\worktrees\\task-1',
          use_worktree: true,
          agent_working_dir: null,
        },
        [{ name: 'contract-review' }]
      )
    ).toBe('C:\\Users\\Administrator\\Documents\\Project\\worktrees\\task-1');
  });

  it('keeps container_ref unchanged for non-worktree workspaces', () => {
    expect(
      deriveWorkspaceRootPath(
        {
          container_ref:
            'C:\\Users\\Administrator\\Documents\\Project\\contract-review',
          use_worktree: false,
          agent_working_dir: null,
        },
        [{ name: 'contract-review' }]
      )
    ).toBe('C:\\Users\\Administrator\\Documents\\Project\\contract-review');
  });

  it('ignores agent_working_dir when deriving explorer root', () => {
    expect(
      deriveWorkspaceRootPath(
        {
          container_ref:
            'C:\\Users\\Administrator\\Documents\\Project\\worktrees\\task-1',
          use_worktree: true,
          agent_working_dir: 'app',
        },
        [{ name: 'contract-review' }]
      )
    ).toBe('C:\\Users\\Administrator\\Documents\\Project\\worktrees\\task-1');
  });

  it('only returns the workspace root candidate', () => {
    expect(
      deriveWorkspaceRootPathCandidates(
        {
          container_ref:
            'C:\\Users\\Administrator\\Documents\\Project\\worktrees\\task-1',
          use_worktree: true,
          agent_working_dir: null,
        },
        [{ name: 'contract-review' }]
      )
    ).toEqual([
      'C:\\Users\\Administrator\\Documents\\Project\\worktrees\\task-1',
    ]);
  });
});

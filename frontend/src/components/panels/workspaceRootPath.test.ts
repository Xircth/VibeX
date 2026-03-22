import { describe, expect, it } from 'vitest';
import { deriveWorkspaceRootPath } from './workspaceRootPath';

describe('deriveWorkspaceRootPath', () => {
  it('appends repo name for worktree workspaces', () => {
    expect(
      deriveWorkspaceRootPath(
        {
          container_ref: 'C:\\Users\\Administrator\\Documents\\Project\\worktrees\\task-1',
          use_worktree: true,
        },
        [{ name: 'contract-review' }]
      )
    ).toBe(
      'C:\\Users\\Administrator\\Documents\\Project\\worktrees\\task-1\\contract-review'
    );
  });

  it('keeps container_ref unchanged for non-worktree workspaces', () => {
    expect(
      deriveWorkspaceRootPath(
        {
          container_ref:
            'C:\\Users\\Administrator\\Documents\\Project\\contract-review',
          use_worktree: false,
        },
        [{ name: 'contract-review' }]
      )
    ).toBe('C:\\Users\\Administrator\\Documents\\Project\\contract-review');
  });
});

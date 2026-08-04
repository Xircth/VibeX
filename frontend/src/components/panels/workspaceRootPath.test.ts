import { describe, expect, it } from 'vitest';
import {
  deriveWorkspaceRootPath,
  deriveWorkspaceRootPathCandidates,
} from './workspaceRootPath';

describe('workspaceRootPath', () => {
  it('treats imported direct worktrees as repo roots even when the folder name differs', () => {
    const workspace = {
      container_ref: 'C:\\worktrees\\repo-feature-b',
      use_worktree: true,
      agent_working_dir: null,
    };
    const workspaceRepos = [
      {
        name: 'repo-feature-a',
      },
    ];

    expect(deriveWorkspaceRootPath(workspace, workspaceRepos)).toBe(
      'C:\\worktrees\\repo-feature-b'
    );
    expect(
      deriveWorkspaceRootPathCandidates(workspace, workspaceRepos)
    ).toEqual([
      'C:\\worktrees\\repo-feature-b',
      'C:\\worktrees\\repo-feature-b\\repo-feature-a',
    ]);
  });

  it('keeps repo subdirectories for managed single-repo workspace containers', () => {
    const workspace = {
      container_ref: 'C:\\Users\\test\\.vibex-workspaces\\ws-123',
      use_worktree: true,
      agent_working_dir: 'repo-feature-a\\frontend',
    };
    const workspaceRepos = [
      {
        name: 'repo-feature-a',
      },
    ];

    expect(deriveWorkspaceRootPath(workspace, workspaceRepos)).toBe(
      'C:\\Users\\test\\.vibex-workspaces\\ws-123\\repo-feature-a'
    );
  });

  it('keeps direct worktree roots when the working dir points at a repo subdirectory', () => {
    const workspace = {
      container_ref: '/worktrees/repo-feature-b',
      use_worktree: true,
      agent_working_dir: 'frontend',
    };
    const workspaceRepos = [
      {
        name: 'repo-feature-a',
      },
    ];

    expect(deriveWorkspaceRootPath(workspace, workspaceRepos)).toBe(
      '/worktrees/repo-feature-b'
    );
    expect(
      deriveWorkspaceRootPathCandidates(workspace, workspaceRepos)
    ).toEqual([
      '/worktrees/repo-feature-b',
      '/worktrees/repo-feature-b/repo-feature-a',
    ]);
  });
});

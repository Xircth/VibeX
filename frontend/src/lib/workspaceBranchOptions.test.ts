import { describe, expect, it } from 'vitest';
import type { GitBranch, Workspace } from 'shared/types';
import {
  buildWorkspaceBranchOptions,
  getWorkspaceBranchCheckoutHint,
  getWorkspaceBranchWarning,
} from './workspaceBranchOptions';

const now = '2026-04-22T10:00:00.000Z';

function createWorkspace(overrides: Partial<Workspace>): Workspace {
  return {
    id: 'workspace-id',
    project_id: 'project-id',
    task_id: 'task-id',
    parent_workspace_id: null,
    container_ref: 'C:\\repo',
    branch: 'feature/worktree',
    use_worktree: true,
    agent_working_dir: null,
    setup_completed_at: null,
    created_at: now,
    updated_at: now,
    archived: false,
    pinned: false,
    name: null,
    ...overrides,
  };
}

function createBranch(overrides: Partial<GitBranch>): GitBranch {
  return {
    name: 'feature/worktree',
    is_current: false,
    is_remote: false,
    last_commit_date: new Date(now),
    ...overrides,
  };
}

describe('buildWorkspaceBranchOptions', () => {
  it('prefers worktree workspaces for matching branches and still includes the current project branch', () => {
    const options = buildWorkspaceBranchOptions({
      workspaces: [
        createWorkspace({
          id: 'root-main',
          branch: 'main',
          use_worktree: false,
        }),
        createWorkspace({
          id: 'wt-feature',
          branch: 'feature/worktree',
          use_worktree: true,
        }),
      ],
      repoBranches: [
        createBranch({
          name: 'main',
          is_current: true,
        }),
        createBranch({
          name: 'feature/worktree',
        }),
      ],
    });

    expect(options).toEqual([
      expect.objectContaining({
        value: 'branch:main',
        branch: 'main',
        useWorktree: false,
        isCurrentProjectBranch: true,
        existingWorkspaceId: 'root-main',
      }),
      expect.objectContaining({
        value: 'workspace:wt-feature',
        branch: 'feature/worktree',
        useWorktree: true,
        existingWorkspaceId: 'wt-feature',
      }),
    ]);
  });

  it('emits warnings for non-worktree branches and checkout hints for non-current project branches', () => {
    const [currentBranchOption, otherBranchOption] =
      buildWorkspaceBranchOptions({
        workspaces: [],
        repoBranches: [
          createBranch({
            name: 'main',
            is_current: true,
          }),
          createBranch({
            name: 'release/1.0',
          }),
        ],
      });

    expect(getWorkspaceBranchWarning(currentBranchOption)).toBe(
      '当前分支非 Git Worktree，建议选择 Worktree 分支。'
    );
    expect(getWorkspaceBranchCheckoutHint(currentBranchOption)).toBeNull();

    expect(getWorkspaceBranchWarning(otherBranchOption)).toBe(
      '当前分支非 Git Worktree，建议选择 Worktree 分支。'
    );
    expect(getWorkspaceBranchCheckoutHint(otherBranchOption)).toBe(
      '选择后会先在当前项目目录 checkout 到该分支，以确保工作区正确。'
    );
  });
});

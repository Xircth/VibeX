import { describe, expect, it } from 'vitest';
import type { GitBranch, Workspace } from 'shared/types';
import {
  buildWorkspaceBranchOptions,
  getWorkspaceBranchCheckoutHint,
  resolveCreateWorkspaceDefault,
  resolveWorkspaceBranchSelection,
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
    is_worktree: false,
    worktree_path: null,
    last_commit_date: new Date(now),
    ...overrides,
  };
}

describe('buildWorkspaceBranchOptions', () => {
  it('prefers the project-root workspace when a worktree shares the current branch', () => {
    const options = buildWorkspaceBranchOptions({
      workspaces: [
        createWorkspace({
          id: 'wt-main',
          branch: 'main',
          use_worktree: true,
          updated_at: '2026-08-31T12:00:00.000Z',
        }),
        createWorkspace({
          id: 'root-main',
          branch: 'main',
          use_worktree: false,
          updated_at: '2026-08-30T12:00:00.000Z',
        }),
      ],
      repoBranches: [
        createBranch({
          name: 'main',
          is_current: true,
        }),
      ],
    });

    expect(options).toEqual([
      expect.objectContaining({
        branch: 'main',
        useWorktree: false,
        isCurrentProjectBranch: true,
        existingWorkspaceId: 'root-main',
      }),
    ]);
  });

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

  it('emits checkout hints only for non-current project branches', () => {
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

    expect(getWorkspaceBranchCheckoutHint(currentBranchOption)).toBeNull();

    expect(getWorkspaceBranchCheckoutHint(otherBranchOption)).toBe(
      '选择后会先在当前项目目录 checkout 到该分支，以确保工作区正确。'
    );
  });

  it('prefers existing workspace ids when building a session selection payload', () => {
    const [projectRootOption, worktreeOption] = buildWorkspaceBranchOptions({
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

    expect(resolveWorkspaceBranchSelection(projectRootOption)).toEqual({
      workspaceId: 'root-main',
      branch: null,
    });
    expect(resolveWorkspaceBranchSelection(worktreeOption)).toEqual({
      workspaceId: 'wt-feature',
      branch: null,
    });
    expect(resolveWorkspaceBranchSelection(null)).toEqual({
      workspaceId: null,
      branch: null,
    });
  });

  it('treats only branches flagged by git worktree metadata as worktree choices without an existing workspace', () => {
    const [option] = buildWorkspaceBranchOptions({
      workspaces: [],
      repoBranches: [
        createBranch({
          name: 'feature/worktree',
          is_worktree: true,
          worktree_path: 'C:\\worktrees\\feature-worktree',
        }),
      ],
    });

    expect(option).toEqual(
      expect.objectContaining({
        branch: 'feature/worktree',
        useWorktree: true,
        existingWorkspaceId: null,
      })
    );
    expect(resolveWorkspaceBranchSelection(option)).toEqual({
      workspaceId: null,
      branch: 'feature/worktree',
    });
  });

  it('does not treat same-prefix manual branches as worktrees without git worktree metadata', () => {
    const [option] = buildWorkspaceBranchOptions({
      workspaces: [],
      repoBranches: [
        createBranch({
          name: 'vu/manual-branch',
        }),
      ],
    });

    expect(option).toEqual(
      expect.objectContaining({
        branch: 'vu/manual-branch',
        useWorktree: false,
        existingWorkspaceId: null,
      })
    );
  });
});

describe('resolveCreateWorkspaceDefault', () => {
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
      createBranch({ name: 'main', is_current: true }),
      createBranch({ name: 'feature/worktree', is_worktree: true }),
    ],
  });

  it('keeps Kanban create on the current project branch', () => {
    expect(
      resolveCreateWorkspaceDefault({
        options,
        lastActiveWorkspaceId: 'wt-feature',
        preferCurrentProjectBranch: true,
      })
    ).toBe('branch:main');
  });

  it('binds Workspace create to the workspace currently in view', () => {
    expect(
      resolveCreateWorkspaceDefault({
        options,
        preferredWorkspaceIds: ['wt-feature', 'root-main'],
      })
    ).toBe('workspace:wt-feature');
  });
});

import { describe, expect, it } from 'vitest';
import type { Workspace } from 'shared/types';
import { resolveDefaultProjectWorkspace } from './workspaceDefault';

const now = '2026-08-31T00:00:00.000Z';

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    id: 'workspace-id',
    project_id: 'project-id',
    task_id: 'task-id',
    parent_workspace_id: null,
    container_ref: '/repo',
    branch: 'main',
    use_worktree: false,
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

describe('resolveDefaultProjectWorkspace', () => {
  it('prefers the project folder on the current branch over a worktree', () => {
    const selected = resolveDefaultProjectWorkspace({
      currentBranch: 'main',
      workspaces: [
        workspace({
          id: 'wt-main',
          use_worktree: true,
          updated_at: '2026-08-31T12:00:00.000Z',
        }),
        workspace({
          id: 'root-main',
          use_worktree: false,
          updated_at: '2026-08-30T12:00:00.000Z',
        }),
      ],
    });

    expect(selected?.id).toBe('root-main');
  });

  it('falls back to the project-root workspace when the current branch has no match', () => {
    const selected = resolveDefaultProjectWorkspace({
      currentBranch: 'develop',
      workspaces: [
        workspace({ id: 'root-main', branch: 'main', use_worktree: false }),
        workspace({
          id: 'wt-feature',
          branch: 'feature',
          use_worktree: true,
        }),
      ],
    });

    expect(selected?.id).toBe('root-main');
  });
});

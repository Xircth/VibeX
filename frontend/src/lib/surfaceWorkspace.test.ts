import { describe, expect, it } from 'vitest';
import type { Workspace } from 'shared/types';

import { resolveSurfaceWorkspaceId } from './surfaceWorkspace';

const now = '2026-10-20T00:00:00.000Z';

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

const root = workspace({ id: 'root' });
const branch = workspace({
  id: 'branch',
  use_worktree: true,
  branch: 'feature',
});

describe('resolveSurfaceWorkspaceId', () => {
  it('keeps the workspace named by the route', () => {
    expect(
      resolveSurfaceWorkspaceId({
        routeWorkspaceId: 'route',
        activeWorkspaceId: 'active',
        rememberedWorkspaceId: 'branch',
        workspaces: [root, branch],
      })
    ).toBe('route');
  });

  it('keeps the active workspace after the route drops it', () => {
    expect(
      resolveSurfaceWorkspaceId({
        routeWorkspaceId: null,
        activeWorkspaceId: 'active',
        rememberedWorkspaceId: 'branch',
        workspaces: [root, branch],
      })
    ).toBe('active');
  });

  it('uses the workspace the project was just in', () => {
    expect(
      resolveSurfaceWorkspaceId({
        rememberedWorkspaceId: 'branch',
        workspaces: [root, branch],
      })
    ).toBe('branch');
  });

  it('falls back to the project root when the remembered workspace is gone', () => {
    expect(
      resolveSurfaceWorkspaceId({
        rememberedWorkspaceId: 'missing',
        workspaces: [root, branch],
        currentBranch: 'feature',
      })
    ).toBe('root');
  });

  it('stays empty until a workspace exists', () => {
    expect(resolveSurfaceWorkspaceId({})).toBeNull();
  });
});

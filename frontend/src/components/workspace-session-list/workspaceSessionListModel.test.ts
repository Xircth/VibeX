import { describe, expect, it } from 'vitest';
import type { Workspace } from 'shared/types';
import type { KanbanProjectSessionRecord } from '@/hooks/useKanbanProjectSessions';
import {
  applyWorkspaceSessionOrder,
  formatCompactSessionAge,
  groupWorkspaceSessions,
  moveSessionInOrder,
  sessionListTitle,
  workspaceGroupLabel,
  workspaceSessionStatusTone,
} from './workspaceSessionListModel';

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'workspace-1',
    project_id: 'project-1',
    task_id: 'task-1',
    parent_workspace_id: null,
    container_ref: null,
    branch: 'main',
    use_worktree: false,
    agent_working_dir: null,
    setup_completed_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    archived: false,
    pinned: false,
    name: null,
    ...overrides,
  };
}

function session(
  overrides: Partial<KanbanProjectSessionRecord> = {}
): KanbanProjectSessionRecord {
  const currentWorkspace = overrides.workspace ?? workspace();
  const id = overrides.id ?? 'session-1';
  return {
    id,
    placement: {
      sessionId: id,
      workspaceId: currentWorkspace.id,
    },
    workspace: currentWorkspace,
    task: null,
    taskId: currentWorkspace.task_id,
    name: null,
    status: 'todo',
    branch: currentWorkspace.branch,
    workspaceName: currentWorkspace.name ?? currentWorkspace.branch,
    workspaceDisplayLabel: `${currentWorkspace.name ?? currentWorkspace.branch} · ${currentWorkspace.branch}`,
    executor: 'grok',
    updatedAt: '2026-08-17T12:00:00Z',
    createdAt: '2026-08-17T10:00:00Z',
    firstPrompt: 'Double Password Prompt on Project Login',
    fullName: 'Double P',
    shortName: 'Double P',
    taskTitle: null,
    isCompleted: false,
    isRunning: false,
    isErrored: false,
    pinnedAt: null,
    ...overrides,
  };
}

describe('workspaceGroupLabel', () => {
  it('uses the branch name for a project-directory workspace', () => {
    expect(
      workspaceGroupLabel(
        session({
          workspace: workspace({
            name: 'VibeX',
            branch: 'feature/session-list',
            use_worktree: false,
          }),
          workspaceName: 'VibeX',
          branch: 'feature/session-list',
        })
      )
    ).toBe('feature/session-list');
  });

  it('uses the worktree name when the workspace is a worktree', () => {
    expect(
      workspaceGroupLabel(
        session({
          workspace: workspace({
            id: 'wt-1',
            name: 'review-login',
            branch: 'feature/login',
            use_worktree: true,
          }),
          workspaceName: 'review-login',
          branch: 'feature/login',
        })
      )
    ).toBe('review-login');
  });

  it('falls back to the worktree branch when the worktree is unnamed', () => {
    expect(
      workspaceGroupLabel(
        session({
          workspace: workspace({
            id: 'wt-2',
            name: null,
            branch: 'hotfix/auth',
            use_worktree: true,
          }),
          workspaceName: '',
          branch: 'hotfix/auth',
        })
      )
    ).toBe('hotfix/auth');
  });
});

describe('groupWorkspaceSessions', () => {
  const main = workspace({ id: 'ws-main', branch: 'main', name: null });
  const worktree = workspace({
    id: 'ws-wt',
    branch: 'feature/login',
    name: 'review-login',
    use_worktree: true,
  });

  it('groups sessions by workspace and keeps newer sessions first', () => {
    const groups = groupWorkspaceSessions([
      session({
        id: 'old-main',
        workspace: main,
        branch: 'main',
        updatedAt: '2026-08-17T10:00:00Z',
      }),
      session({
        id: 'new-wt',
        workspace: worktree,
        branch: 'feature/login',
        workspaceName: 'review-login',
        updatedAt: '2026-08-17T12:00:00Z',
      }),
      session({
        id: 'new-main',
        workspace: main,
        branch: 'main',
        updatedAt: '2026-08-17T11:00:00Z',
      }),
    ]);

    expect(groups.map((group) => group.workspaceId)).toEqual([
      'ws-wt',
      'ws-main',
    ]);
    expect(groups[0]).toMatchObject({
      label: 'review-login',
      useWorktree: true,
    });
    expect(groups[1].sessions.map((item) => item.id)).toEqual([
      'new-main',
      'old-main',
    ]);
  });

  it('keeps the active workspace first even when it is older', () => {
    const groups = groupWorkspaceSessions(
      [
        session({
          id: 'wt',
          workspace: worktree,
          workspaceName: 'review-login',
          updatedAt: '2026-08-17T12:00:00Z',
        }),
        session({
          id: 'main',
          workspace: main,
          updatedAt: '2026-08-17T09:00:00Z',
        }),
      ],
      { activeWorkspaceId: 'ws-main' }
    );

    expect(groups.map((group) => group.workspaceId)).toEqual([
      'ws-main',
      'ws-wt',
    ]);
  });

  it('keeps pinned sessions above newer unpinned ones in a workspace', () => {
    const main = workspace({ id: 'ws-main', branch: 'main', name: null });
    const groups = groupWorkspaceSessions([
      session({
        id: 'newer',
        workspace: main,
        updatedAt: '2026-08-17T12:00:00Z',
      }),
      session({
        id: 'pinned',
        workspace: main,
        pinnedAt: '2026-08-17T09:00:00Z',
        updatedAt: '2026-08-17T08:00:00Z',
      }),
    ]);

    expect(groups[0]?.sessions.map((item) => item.id)).toEqual([
      'pinned',
      'newer',
    ]);
  });

  it('uses a saved workspace order instead of recency', () => {
    const main = workspace({ id: 'ws-main', branch: 'main', name: null });
    const groups = groupWorkspaceSessions(
      [
        session({
          id: 'older',
          workspace: main,
          updatedAt: '2026-08-17T10:00:00Z',
        }),
        session({
          id: 'newer',
          workspace: main,
          updatedAt: '2026-08-17T12:00:00Z',
        }),
      ],
      { sessionOrderByWorkspace: { 'ws-main': ['older', 'newer'] } }
    );

    expect(groups[0]?.sessions.map((item) => item.id)).toEqual([
      'older',
      'newer',
    ]);
  });
});

describe('sessionListTitle', () => {
  it('prefers a manual name over the prompt preview', () => {
    expect(
      sessionListTitle(
        session({
          name: 'Login review',
          firstPrompt: 'Double Password Prompt on Project Login',
          fullName: 'Login r',
        })
      )
    ).toBe('Login review');
  });

  it('uses the first prompt when the session has no manual name', () => {
    expect(sessionListTitle(session())).toBe(
      'Double Password Prompt on Project Login'
    );
  });

  it('falls back to the derived full name', () => {
    expect(
      sessionListTitle(
        session({
          name: '   ',
          firstPrompt: null,
          fullName: '新会话1',
        })
      )
    ).toBe('新会话1');
  });
});

describe('workspaceSessionStatusTone', () => {
  it('maps the session status colors used by the workbench', () => {
    expect(workspaceSessionStatusTone({ status: 'todo' })).toBe('todo');
    expect(workspaceSessionStatusTone({ status: 'inprogress' })).toBe(
      'inprogress'
    );
    expect(workspaceSessionStatusTone({ status: 'inreview' })).toBe('inreview');
    expect(workspaceSessionStatusTone({ status: 'done' })).toBe('done');
    expect(workspaceSessionStatusTone({ status: 'archived' })).toBe('done');
  });
});

describe('applyWorkspaceSessionOrder', () => {
  const main = workspace({ id: 'ws-main', branch: 'main', name: null });

  it('places new sessions ahead of a saved order', () => {
    const ordered = applyWorkspaceSessionOrder(
      [
        session({
          id: 'older',
          workspace: main,
          updatedAt: '2026-08-17T10:00:00Z',
        }),
        session({
          id: 'newer',
          workspace: main,
          updatedAt: '2026-08-17T12:00:00Z',
        }),
        session({
          id: 'fresh',
          workspace: main,
          updatedAt: '2026-08-17T13:00:00Z',
        }),
      ],
      ['older', 'newer']
    );

    expect(ordered.map((item) => item.id)).toEqual(['fresh', 'older', 'newer']);
  });
});

describe('moveSessionInOrder', () => {
  it('moves the second session in front of the first', () => {
    expect(moveSessionInOrder(['first', 'second'], 'second', 'first')).toEqual([
      'second',
      'first',
    ]);
  });

  it('returns null when the order does not change', () => {
    expect(
      moveSessionInOrder(['first', 'second'], 'first', 'first')
    ).toBeNull();
    expect(moveSessionInOrder(['first'], 'missing', 'first')).toBeNull();
  });
});

describe('formatCompactSessionAge', () => {
  const now = Date.parse('2026-08-17T12:00:00Z');

  it('uses compact age units for the dense list', () => {
    expect(formatCompactSessionAge('2026-08-17T11:59:20Z', now)).toBe('now');
    expect(formatCompactSessionAge('2026-08-17T11:35:00Z', now)).toBe('25m');
    expect(formatCompactSessionAge('2026-08-17T11:00:00Z', now)).toBe('1h');
    expect(formatCompactSessionAge('2026-08-15T12:00:00Z', now)).toBe('2d');
  });
});

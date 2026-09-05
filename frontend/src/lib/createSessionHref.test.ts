import { describe, expect, it } from 'vitest';
import {
  resolveCreateSessionHref,
  resolveWorkspaceTabNavigation,
} from './createSessionHref';

describe('resolveCreateSessionHref', () => {
  it('opens the execution-area overlay on the Kanban page', () => {
    expect(
      resolveCreateSessionHref({
        projectId: 'project-1',
        isWorkspaceTab: false,
      })
    ).toBe('/local-projects/project-1/sessions?newSession=1');
  });

  it('opens the execution-area overlay on the Workspace page', () => {
    expect(
      resolveCreateSessionHref({
        projectId: 'project-1',
        isWorkspaceTab: true,
        workspaceId: 'workspace-1',
      })
    ).toBe('/local-projects/project-1/workspaces/workspace-1?newSession=1');
  });

  it('falls back to the active worktree when the workspace route is not ready yet', () => {
    expect(
      resolveCreateSessionHref({
        projectId: 'project-1',
        isWorkspaceTab: true,
        activeWorktreeId: 'workspace-2',
      })
    ).toBe('/local-projects/project-1/workspaces/workspace-2?newSession=1');
  });
});

describe('resolveWorkspaceTabNavigation', () => {
  it('binds the Kanban execution session before navigating to Workspace', () => {
    expect(
      resolveWorkspaceTabNavigation({
        projectId: 'project-1',
        rightSession: {
          workspaceId: 'workspace-exec',
          sessionId: 'session-exec',
        },
        fallbackWorkspaceId: 'workspace-fallback',
      })
    ).toEqual({
      workspaceId: 'workspace-exec',
      taskId: null,
      href: '/local-projects/project-1/workspaces/workspace-exec/sessions/session-exec',
    });
  });

  it('binds the fallback workspace when Kanban has no execution session', () => {
    expect(
      resolveWorkspaceTabNavigation({
        projectId: 'project-1',
        fallbackWorkspaceId: 'workspace-fallback',
        fallbackTaskId: 'task-1',
      })
    ).toEqual({
      workspaceId: 'workspace-fallback',
      taskId: 'task-1',
      href: '/local-projects/project-1/workspaces/workspace-fallback',
    });
  });
});

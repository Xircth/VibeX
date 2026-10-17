import { describe, expect, it } from 'vitest';
import {
  preserveCreateSessionQuery,
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

  it('restores the last session when returning to the workspace surface', () => {
    expect(
      resolveWorkspaceTabNavigation({
        projectId: 'project-1',
        lastRoute:
          '/local-projects/project-1/workspaces/workspace-last/sessions/session-last',
        fallbackWorkspaceId: 'workspace-root',
      })
    ).toEqual({
      workspaceId: 'workspace-last',
      taskId: null,
      href: '/local-projects/project-1/workspaces/workspace-last/sessions/session-last',
    });
  });

  it('prefers the last session over a live execution-area session', () => {
    expect(
      resolveWorkspaceTabNavigation({
        projectId: 'project-1',
        lastRoute:
          '/local-projects/project-1/workspaces/workspace-last/sessions/session-last',
        rightSession: {
          workspaceId: 'workspace-exec',
          sessionId: 'session-exec',
        },
        fallbackWorkspaceId: 'workspace-root',
      })
    ).toEqual({
      workspaceId: 'workspace-last',
      taskId: null,
      href: '/local-projects/project-1/workspaces/workspace-last/sessions/session-last',
    });
  });

  it('ignores a last route that belongs to another project', () => {
    expect(
      resolveWorkspaceTabNavigation({
        projectId: 'project-1',
        lastRoute:
          '/local-projects/project-other/workspaces/workspace-last/sessions/session-last',
        fallbackWorkspaceId: 'workspace-root',
      })
    ).toEqual({
      workspaceId: 'workspace-root',
      taskId: null,
      href: '/local-projects/project-1/workspaces/workspace-root',
    });
  });
});

describe('preserveCreateSessionQuery', () => {
  it('keeps newSession=1 when landing navigation replaces the URL', () => {
    expect(
      preserveCreateSessionQuery(
        '/local-projects/project-1/workspaces/workspace-1/sessions/session-1',
        new URLSearchParams('newSession=1')
      )
    ).toBe(
      '/local-projects/project-1/workspaces/workspace-1/sessions/session-1?newSession=1'
    );
  });

  it('leaves a URL unchanged when New Session was not requested', () => {
    expect(
      preserveCreateSessionQuery(
        '/local-projects/project-1/workspaces/workspace-1',
        new URLSearchParams()
      )
    ).toBe('/local-projects/project-1/workspaces/workspace-1');
  });
});

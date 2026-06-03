import { beforeEach, describe, expect, it } from 'vitest';
import { useWindowProjectsStore } from './useWindowProjectsStore';

describe('useWindowProjectsStore', () => {
  beforeEach(() => {
    useWindowProjectsStore.getState().resetProjectWindowState();
  });

  it('replaces project tracking state from another window snapshot', () => {
    useWindowProjectsStore.getState().replaceProjectTrackingState({
      openProjectIds: ['project-1'],
      lastRouteByProject: {
        'project-1': '/local-projects/project-1/sessions',
      },
      projectSnapshots: {
        'project-1': {
          isLoading: false,
          hasRunning: true,
          hasError: false,
          hasSessions: true,
          recentSessions: [
            {
              sessionId: 'session-1',
              workspaceId: 'workspace-1',
              taskId: 'task-1',
              title: 'Session 1',
              subtitle: 'Workspace 1 路 main',
              statusLabel: 'Running',
              visualState: 'loading',
              updatedAt: '2026-06-03T00:00:00.000Z',
            },
          ],
        },
      },
      projectAlerts: {
        'project-1': {
          projectId: 'project-1',
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          taskId: 'task-1',
          kind: 'success',
          unread: true,
          createdAt: '2026-06-03T00:00:00.000Z',
          title: 'Done',
          description: 'Session finished',
        },
      },
    });

    const state = useWindowProjectsStore.getState();
    expect(state.openProjectIds).toEqual(['project-1']);
    expect(state.lastRouteByProject).toEqual({
      'project-1': '/local-projects/project-1/sessions',
    });
    expect(state.projectSnapshots['project-1']?.hasRunning).toBe(true);
    expect(state.projectAlerts['project-1']?.title).toBe('Done');
  });
});

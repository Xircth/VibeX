import { beforeEach, describe, expect, it } from 'vitest';

import { useWindowProjectsStore } from './useWindowProjectsStore';

describe('useWindowProjectsStore', () => {
  beforeEach(() => {
    useWindowProjectsStore.getState().resetProjectWindowState();
  });
  it('keeps every selected project open, including selections larger than six', () => {
    const ids = Array.from({ length: 9 }, (_, index) => `selected-${index}`);
    for (const id of ids)
      useWindowProjectsStore.getState().ensureProjectOpen(id);
    expect(useWindowProjectsStore.getState().openProjectIds).toEqual(
      [...ids].reverse()
    );
  });

  it('repairs a persisted image address when restoring open projects', async () => {
    localStorage.setItem(
      'vibex-window-projects',
      JSON.stringify({
        version: 7,
        state: {
          openProjectIds: ['project-1'],
          lastRouteByProject: {
            'project-1':
              '/local-projects/project-1/workspaces/workspace-1/evidence/agent-runtime-status-zh.png',
          },
        },
      })
    );

    await useWindowProjectsStore.persist.rehydrate();

    expect(useWindowProjectsStore.getState().openProjectIds).toEqual([
      'project-1',
    ]);
    expect(
      useWindowProjectsStore.getState().lastRouteByProject['project-1']
    ).toBe('/local-projects/project-1/workspaces/workspace-1');
  });

  it('remembers the working parent instead of an unsupported file address', () => {
    useWindowProjectsStore
      .getState()
      .rememberProjectRoute(
        'project-1',
        '/local-projects/project-1/workspaces/workspace-1/evidence/image.png'
      );

    expect(
      useWindowProjectsStore.getState().lastRouteByProject['project-1']
    ).toBe('/local-projects/project-1/workspaces/workspace-1');
  });

  it('does not wipe open projects when prune is called with an empty list', () => {
    useWindowProjectsStore.setState({
      openProjectIds: ['codeg', 'open-connector'],
      projectSnapshots: {
        codeg: {
          isLoading: false,
          hasRunning: false,
          runningCount: 0,
          hasError: false,
          hasSessions: false,
          recentSessions: [],
        },
      },
    });

    useWindowProjectsStore.getState().pruneProjectState([]);

    expect(useWindowProjectsStore.getState().openProjectIds).toEqual([
      'codeg',
      'open-connector',
    ]);
    expect(useWindowProjectsStore.getState().projectSnapshots).toHaveProperty(
      'codeg'
    );
  });

  it('still prunes projects that are no longer in the known list', () => {
    useWindowProjectsStore.setState({
      openProjectIds: ['codeg', 'gone'],
      projectSnapshots: {
        codeg: {
          isLoading: false,
          hasRunning: false,
          runningCount: 0,
          hasError: false,
          hasSessions: false,
          recentSessions: [],
        },
        gone: {
          isLoading: false,
          hasRunning: false,
          runningCount: 0,
          hasError: false,
          hasSessions: false,
          recentSessions: [],
        },
      },
    });

    useWindowProjectsStore.getState().pruneProjectState(['codeg']);

    expect(useWindowProjectsStore.getState().openProjectIds).toEqual(['codeg']);
    expect(useWindowProjectsStore.getState().projectSnapshots).toEqual({
      codeg: expect.any(Object),
    });
  });

  it('stores a dragged rail position and resets to centered default when reopened', () => {
    useWindowProjectsStore.getState().setRailPosition({ x: 48, y: 120 });
    expect(useWindowProjectsStore.getState().railPosition).toEqual({
      x: 48,
      y: 120,
    });

    useWindowProjectsStore.getState().setRailVisible(true);
    expect(useWindowProjectsStore.getState().railPosition).toBeNull();

    useWindowProjectsStore.getState().setRailPosition({ x: 8, y: 8 });
    useWindowProjectsStore.getState().setRailVisible(false);
    useWindowProjectsStore.getState().toggleRailVisible();
    expect(useWindowProjectsStore.getState().railVisible).toBe(true);
    expect(useWindowProjectsStore.getState().railPosition).toBeNull();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';

import { useWindowProjectsStore } from './useWindowProjectsStore';

describe('useWindowProjectsStore', () => {
  beforeEach(() => {
    useWindowProjectsStore.getState().resetProjectWindowState();
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

  it('stores a dragged rail position', () => {
    useWindowProjectsStore.getState().setRailPosition({ x: 48, y: 120 });
    expect(useWindowProjectsStore.getState().railPosition).toEqual({
      x: 48,
      y: 120,
    });
  });
});

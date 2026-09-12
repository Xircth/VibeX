import { describe, expect, it } from 'vitest';
import {
  activateSessionInExecutionArea,
  appendMonitorSession,
  createEmptyKanbanSessionLayoutState,
  placeCreatedSession,
  placeForkedChild,
  placeSessionFromList,
  promoteMonitorSessionToRight,
  pruneUnavailableSessions,
  removeMonitorSession,
  replaceRightSession,
  resolveCurrentExecutionPlacement,
  shouldPruneKanbanSessionPlacements,
  type KanbanSessionPlacement,
} from './kanbanSessionLayout';

function session(
  sessionId: string,
  workspaceId: string = `workspace-${sessionId}`
): KanbanSessionPlacement {
  return { sessionId, workspaceId };
}

describe('kanban session layout', () => {
  it('places the first clicked session in the right panel when available', () => {
    const next = placeSessionFromList(
      createEmptyKanbanSessionLayoutState(),
      session('a'),
      { canUseRightPanel: true }
    );

    expect(next.rightSession?.sessionId).toBe('a');
    expect(next.monitorSessions).toHaveLength(0);
  });

  it('queues list clicks into monitor slots when the right panel already has a session', () => {
    const state = {
      rightSession: session('right'),
      monitorSessions: [session('a')],
    };

    const next = placeSessionFromList(state, session('b'), {
      canUseRightPanel: true,
    });

    expect(next.rightSession?.sessionId).toBe('right');
    expect(next.monitorSessions.map((item) => item.sessionId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('keeps only the latest four monitor sessions in FIFO order', () => {
    const queue = ['a', 'b', 'c', 'd', 'e'].reduce(
      (sessions, id) => appendMonitorSession(sessions, session(id)),
      [] as KanbanSessionPlacement[]
    );

    expect(queue.map((item) => item.sessionId)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('swaps a monitor session into the right panel and appends the old right session to the tail', () => {
    const state = {
      rightSession: session('right'),
      monitorSessions: [session('a'), session('b'), session('c')],
    };

    const next = promoteMonitorSessionToRight(state, 'b', {
      canUseRightPanel: true,
    });

    expect(next.rightSession?.sessionId).toBe('b');
    expect(next.monitorSessions.map((item) => item.sessionId)).toEqual([
      'a',
      'c',
      'right',
    ]);
  });

  it('swaps a notification session from the list into the execution area', () => {
    const state = {
      rightSession: session('right'),
      monitorSessions: [session('monitor')],
    };

    const next = activateSessionInExecutionArea(state, session('notifying'), {
      canUseRightPanel: true,
    });

    expect(next.rightSession?.sessionId).toBe('notifying');
    expect(next.monitorSessions.map((item) => item.sessionId)).toEqual([
      'monitor',
      'right',
    ]);
  });

  it('promotes an already monitored notification session without duplicating it', () => {
    const state = {
      rightSession: session('right'),
      monitorSessions: [session('a'), session('notifying')],
    };

    const next = activateSessionInExecutionArea(state, session('notifying'), {
      canUseRightPanel: true,
    });

    expect(next.rightSession?.sessionId).toBe('notifying');
    expect(next.monitorSessions.map((item) => item.sessionId)).toEqual([
      'a',
      'right',
    ]);
  });

  it('puts a forked child in the right slot without parking the parent', () => {
    const state = {
      rightSession: session('parent'),
      monitorSessions: [session('a'), session('child')],
    };

    const next = placeForkedChild(state, session('child'), 'parent', {
      canUseRightPanel: true,
    });

    expect(next.rightSession?.sessionId).toBe('child');
    expect(next.monitorSessions.map((item) => item.sessionId)).toEqual(['a']);
  });

  it('promotes a newly created session into the right panel and queues the previous right session', () => {
    const state = {
      rightSession: session('right'),
      monitorSessions: [session('a')],
    };

    const next = placeCreatedSession(state, session('new'), {
      canUseRightPanel: true,
    });

    expect(next.rightSession?.sessionId).toBe('new');
    expect(next.monitorSessions.map((item) => item.sessionId)).toEqual([
      'a',
      'right',
    ]);
  });

  it('prunes sessions that are no longer available', () => {
    const state = {
      rightSession: session('right'),
      monitorSessions: [session('a'), session('b')],
    };

    const next = pruneUnavailableSessions(state, new Set(['b']));

    expect(next.rightSession).toBeNull();
    expect(next.monitorSessions.map((item) => item.sessionId)).toEqual(['b']);
  });

  it('does not prune placements against an empty or unready session snapshot', () => {
    expect(
      shouldPruneKanbanSessionPlacements({
        isLayoutHydrated: true,
        isLoading: false,
        availableSessionCount: 0,
      })
    ).toBe(false);
    expect(
      shouldPruneKanbanSessionPlacements({
        isLayoutHydrated: false,
        isLoading: false,
        availableSessionCount: 2,
      })
    ).toBe(false);
    expect(
      shouldPruneKanbanSessionPlacements({
        isLayoutHydrated: true,
        isLoading: true,
        availableSessionCount: 2,
      })
    ).toBe(false);
    expect(
      shouldPruneKanbanSessionPlacements({
        isLayoutHydrated: true,
        isLoading: false,
        availableSessionCount: 2,
      })
    ).toBe(true);
  });

  it('replaces the right panel session without queueing the previous one', () => {
    const state = {
      rightSession: session('right'),
      monitorSessions: [session('a'), session('b')],
    };

    const next = replaceRightSession(state, session('new'), {
      canUseRightPanel: true,
    });

    expect(next.rightSession?.sessionId).toBe('new');
    expect(next.monitorSessions.map((item) => item.sessionId)).toEqual([
      'a',
      'b',
    ]);
  });

  it('removes a session from monitor slots without changing the right panel', () => {
    const state = {
      rightSession: session('right'),
      monitorSessions: [session('a'), session('b')],
    };

    const next = removeMonitorSession(state, 'a');

    expect(next.rightSession?.sessionId).toBe('right');
    expect(next.monitorSessions.map((item) => item.sessionId)).toEqual(['b']);
  });

  it('uses the right panel session as the execution placement when it differs from the active workspace', () => {
    const next = resolveCurrentExecutionPlacement(
      session('right'),
      session('active'),
      { canUseRightPanel: true }
    );

    expect(next?.sessionId).toBe('right');
  });

  it('falls back to the active workspace session when the right panel has not been seeded', () => {
    const next = resolveCurrentExecutionPlacement(null, session('active'), {
      canUseRightPanel: true,
    });

    expect(next?.sessionId).toBe('active');
  });

  it('does not hide monitor sessions behind an execution placement when the right panel is unavailable', () => {
    const next = resolveCurrentExecutionPlacement(null, session('active'), {
      canUseRightPanel: false,
    });

    expect(next).toBeNull();
  });

  it('parks the previous execution session in the monitor FIFO when another session is activated', () => {
    const state = {
      rightSession: session('a'),
      monitorSessions: [session('b'), session('c'), session('d'), session('e')],
    };

    const next = activateSessionInExecutionArea(state, session('f'), {
      canUseRightPanel: true,
    });

    expect(next.rightSession?.sessionId).toBe('f');
    expect(next.monitorSessions.map((item) => item.sessionId)).toEqual([
      'c',
      'd',
      'e',
      'a',
    ]);
  });

  it('keeps placements whose workspace has not loaded yet', () => {
    const state = {
      rightSession: session('a', 'ws-a'),
      monitorSessions: [session('b', 'ws-b'), session('c', 'ws-c')],
    };

    const next = pruneUnavailableSessions(state, new Set(['a']), {
      knownWorkspaceIds: new Set(['ws-a']),
    });

    expect(next.rightSession?.sessionId).toBe('a');
    expect(next.monitorSessions.map((item) => item.sessionId)).toEqual([
      'b',
      'c',
    ]);
  });

  it('prunes a missing session once its workspace has loaded', () => {
    const state = {
      rightSession: session('a', 'ws-a'),
      monitorSessions: [session('gone', 'ws-a'), session('b', 'ws-b')],
    };

    const next = pruneUnavailableSessions(state, new Set(['a']), {
      knownWorkspaceIds: new Set(['ws-a']),
    });

    expect(next.rightSession?.sessionId).toBe('a');
    expect(next.monitorSessions.map((item) => item.sessionId)).toEqual(['b']);
  });
});

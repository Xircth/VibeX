import { describe, expect, it } from 'vitest';
import {
  appendMonitorSession,
  createEmptyKanbanSessionLayoutState,
  placeCreatedSession,
  placeSessionFromList,
  promoteMonitorSessionToRight,
  pruneUnavailableSessions,
  removeMonitorSession,
  replaceRightSession,
  resolveCurrentExecutionPlacement,
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
      session('active')
    );

    expect(next?.sessionId).toBe('right');
  });

  it('falls back to the active workspace session when the right panel has not been seeded', () => {
    const next = resolveCurrentExecutionPlacement(null, session('active'));

    expect(next?.sessionId).toBe('active');
  });
});

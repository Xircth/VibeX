import { describe, expect, it } from 'vitest';
import { reconcileWorkspaceSessionSelection } from './useWorkspaceSessions';

describe('reconcileWorkspaceSessionSelection', () => {
  it('keeps a pending session over an older in-list selection', () => {
    const next = reconcileWorkspaceSessionSelection({
      prev: { mode: 'existing', sessionId: 'session-a' },
      sessionIds: ['session-a', 'session-b'],
      initialSessionId: 'session-b',
      pendingSessionId: 'session-b',
      autoSelectFirstSession: true,
      workspaceChanged: false,
    });

    expect(next.selection).toEqual({
      mode: 'existing',
      sessionId: 'session-b',
    });
    expect(next.pendingSessionId).toBeNull();
  });

  it('does not drop a just-created session while the list is still empty', () => {
    const next = reconcileWorkspaceSessionSelection({
      prev: { mode: 'existing', sessionId: 'session-new' },
      sessionIds: [],
      initialSessionId: 'session-new',
      pendingSessionId: 'session-new',
      autoSelectFirstSession: true,
      workspaceChanged: false,
    });

    expect(next.selection).toEqual({
      mode: 'existing',
      sessionId: 'session-new',
    });
    expect(next.pendingSessionId).toBe('session-new');
  });

  it('keeps a local composer selection when the parent id has not echoed yet', () => {
    const next = reconcileWorkspaceSessionSelection({
      prev: { mode: 'existing', sessionId: 'session-b' },
      sessionIds: ['session-a', 'session-b'],
      initialSessionId: 'session-a',
      pendingSessionId: null,
      autoSelectFirstSession: true,
      workspaceChanged: false,
    });

    expect(next.selection).toEqual({
      mode: 'existing',
      sessionId: 'session-b',
    });
  });

  it('preserves pending across a workspace change when it matches the new initial id', () => {
    const next = reconcileWorkspaceSessionSelection({
      prev: { mode: 'existing', sessionId: 'session-a' },
      sessionIds: ['session-b'],
      initialSessionId: 'session-b',
      pendingSessionId: 'session-b',
      autoSelectFirstSession: true,
      workspaceChanged: true,
    });

    expect(next.selection).toEqual({
      mode: 'existing',
      sessionId: 'session-b',
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  getCreatedSessionProfileMemoryUpdate,
  getComposerSessionId,
  getComposerSessionLabels,
  getComposerSessionSelectionNotification,
  getComposerScratchTargetId,
  getComposerWorkspaceId,
  getSessionRenameInvalidation,
  truncateComposerSessionLabel,
} from './sessionComposerSession';

describe('session composer session helpers', () => {
  it('resolves workspace id from the explicit source priority', () => {
    expect(
      getComposerWorkspaceId({
        activeWorktreeId: 'worktree',
        routeWorkspaceId: 'route',
        workspaceIdProp: 'prop',
        sessionWorkspaceId: 'session',
      })
    ).toBe('worktree');
    expect(
      getComposerWorkspaceId({
        activeWorktreeId: null,
        routeWorkspaceId: 'route',
        workspaceIdProp: 'prop',
        sessionWorkspaceId: 'session',
      })
    ).toBe('route');
    expect(
      getComposerWorkspaceId({
        activeWorktreeId: null,
        routeWorkspaceId: undefined,
        workspaceIdProp: 'prop',
        sessionWorkspaceId: 'session',
      })
    ).toBe('prop');
    expect(
      getComposerWorkspaceId({
        activeWorktreeId: null,
        routeWorkspaceId: undefined,
        workspaceIdProp: undefined,
        sessionWorkspaceId: 'session',
      })
    ).toBe('session');
    expect(
      getComposerWorkspaceId({
        activeWorktreeId: null,
        routeWorkspaceId: undefined,
        workspaceIdProp: undefined,
        sessionWorkspaceId: undefined,
      })
    ).toBeNull();
  });

  it('suppresses the active session id while creating a new session', () => {
    expect(
      getComposerSessionId({ isNewSessionMode: true, sessionId: 's1' })
    ).toBeUndefined();
    expect(
      getComposerSessionId({ isNewSessionMode: false, sessionId: 's1' })
    ).toBe('s1');
    expect(
      getComposerSessionId({ isNewSessionMode: false, sessionId: undefined })
    ).toBeUndefined();
  });

  it('derives the scratch target id from session mode', () => {
    expect(
      getComposerScratchTargetId({
        isNewSessionMode: true,
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
      })
    ).toBe('workspace-1');

    expect(
      getComposerScratchTargetId({
        isNewSessionMode: false,
        workspaceId: 'workspace-1',
        sessionId: 'session-1',
      })
    ).toBe('session-1');

    expect(
      getComposerScratchTargetId({
        isNewSessionMode: true,
        workspaceId: null,
        sessionId: 'session-1',
      })
    ).toBeUndefined();

    expect(
      getComposerScratchTargetId({
        isNewSessionMode: false,
        workspaceId: 'workspace-1',
        sessionId: undefined,
      })
    ).toBeUndefined();
  });

  it('builds session selection notifications only when a workspace exists', () => {
    expect(
      getComposerSessionSelectionNotification({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
      })
    ).toEqual({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    });

    expect(
      getComposerSessionSelectionNotification({
        sessionId: 'session-1',
        workspaceId: undefined,
      })
    ).toBeNull();
  });

  it('remembers created-session profiles only when an executor exists', () => {
    const profile = { executor: 'codex' as const, variant: 'PLAN' };

    expect(
      getCreatedSessionProfileMemoryUpdate({
        sessionId: 'session-1',
        profile,
      })
    ).toEqual({
      sessionId: 'session-1',
      profile,
    });

    expect(
      getCreatedSessionProfileMemoryUpdate({
        sessionId: 'session-1',
        profile: null,
      })
    ).toBeNull();

    expect(
      getCreatedSessionProfileMemoryUpdate({
        sessionId: 'session-1',
        profile: { variant: 'PLAN' },
      })
    ).toBeNull();
  });

  it('derives rename invalidation keys from the available workspace', () => {
    expect(
      getSessionRenameInvalidation({
        targetSessionId: 'session-1',
        workspaceId: 'workspace-1',
      })
    ).toEqual({
      workspaceSessionsQueryKey: ['workspaceSessions', 'workspace-1'],
      sessionQueryKey: ['session', 'session-1'],
    });

    expect(
      getSessionRenameInvalidation({
        targetSessionId: 'session-1',
        workspaceId: undefined,
      })
    ).toEqual({
      workspaceSessionsQueryKey: null,
      sessionQueryKey: ['session', 'session-1'],
    });
  });

  it('derives full and compact session selector labels', () => {
    expect(
      getComposerSessionLabels({
        sessions: [
          {
            id: 's1',
            displayName: 'Alpha Session',
          },
        ],
        selectedSessionId: 's1',
        isNewSessionMode: false,
      })
    ).toEqual({
      selectedSessionLabel: 'Alpha Session',
      compactSessionLabel: 'Alpha Se',
    });

    expect(
      getComposerSessionLabels({
        sessions: [{ id: 's1', displayName: 'Alpha' }],
        selectedSessionId: 'missing',
        isNewSessionMode: false,
      })
    ).toEqual({
      selectedSessionLabel: '\u4f1a\u8bdd',
      compactSessionLabel: '\u4f1a\u8bdd',
    });

    expect(
      getComposerSessionLabels({
        sessions: [
          { id: 's1', displayName: 'Alpha' },
          { id: 's2', displayName: 'Beta' },
        ],
        selectedSessionId: undefined,
        isNewSessionMode: true,
      })
    ).toEqual({
      selectedSessionLabel: '\u4f1a\u8bdd3',
      compactSessionLabel: '\u4f1a\u8bdd3',
    });
  });

  it('truncates labels by ASCII and CJK display units', () => {
    expect(truncateComposerSessionLabel('Alpha Session', 8)).toBe('Alpha Se');
    expect(truncateComposerSessionLabel('\u4f1a\u8bddAlpha', 6)).toBe(
      '\u4f1a\u8bddAl'
    );
    expect(truncateComposerSessionLabel('', 8)).toBe('\u4f1a\u8bdd');
  });

  it('preserves and persists pre-selected controls across in-workspace new-session auto-creation while resetting on session/executor switches', async () => {
    const {
      resolveComposerControlScopeTransition,
      persistPendingSessionControls,
    } = await import('./sessionComposerSession');

    const autoCreated = { sessionId: 'created-1', executor: 'codex' };

    // 1. undefined -> created-1 for same executor preserves controls and triggers persistence
    const initialActivation = resolveComposerControlScopeTransition({
      previous: {
        sessionId: undefined,
        targetExecutor: 'codex',
        resolvedSessionExecutor: null,
      },
      current: {
        sessionId: 'created-1',
        targetExecutor: 'codex',
        resolvedSessionExecutor: null,
      },
      autoCreatedSession: autoCreated,
    });
    expect(initialActivation).toEqual({
      shouldReset: false,
      shouldPersistToAutoCreatedSession: true,
      nextAutoCreatedSession: autoCreated,
    });

    // 2. Subsequent resolvedSessionExecutor hydration for same executor also preserves controls and clears ref
    const hydrated = resolveComposerControlScopeTransition({
      previous: {
        sessionId: 'created-1',
        targetExecutor: 'codex',
        resolvedSessionExecutor: null,
      },
      current: {
        sessionId: 'created-1',
        targetExecutor: 'codex',
        resolvedSessionExecutor: 'codex',
      },
      autoCreatedSession: initialActivation.nextAutoCreatedSession,
    });
    expect(hydrated).toEqual({
      shouldReset: false,
      shouldPersistToAutoCreatedSession: false,
      nextAutoCreatedSession: null,
    });

    // 3. Switching between two distinct sessions resets cleanly
    expect(
      resolveComposerControlScopeTransition({
        previous: {
          sessionId: 'created-1',
          targetExecutor: 'codex',
          resolvedSessionExecutor: 'codex',
        },
        current: {
          sessionId: 'session-2',
          targetExecutor: 'codex',
          resolvedSessionExecutor: 'codex',
        },
        autoCreatedSession: null,
      })
    ).toEqual({
      shouldReset: true,
      shouldPersistToAutoCreatedSession: false,
      nextAutoCreatedSession: null,
    });

    // 4. Changing executor resets cleanly even if autoCreatedSession was set
    expect(
      resolveComposerControlScopeTransition({
        previous: {
          sessionId: 'created-1',
          targetExecutor: 'codex',
          resolvedSessionExecutor: null,
        },
        current: {
          sessionId: 'created-1',
          targetExecutor: 'claude_code',
          resolvedSessionExecutor: null,
        },
        autoCreatedSession: autoCreated,
      })
    ).toEqual({
      shouldReset: true,
      shouldPersistToAutoCreatedSession: false,
      nextAutoCreatedSession: null,
    });

    // 5. persistPendingSessionControls persists mode and non-empty config options while swallowing transient rejections
    const calls: unknown[] = [];
    persistPendingSessionControls({
      conversationId: 'created-1',
      selectedMode: 'plan',
      selectedConfigValues: {
        model: 'gpt-5',
        effort: 'high',
        empty: '',
      },
      setSessionMode: async (args) => {
        calls.push(['mode', args]);
        throw new Error('transient unbound');
      },
      setSessionConfigOption: async (args) => {
        calls.push(['config', args]);
      },
    });
    await Promise.resolve();
    expect(calls).toEqual([
      ['mode', { conversationId: 'created-1', modeId: 'plan' }],
      ['config', { conversationId: 'created-1', key: 'model', value: 'gpt-5' }],
      [
        'config',
        { conversationId: 'created-1', key: 'effort', value: 'high' },
      ],
    ]);
  });
});

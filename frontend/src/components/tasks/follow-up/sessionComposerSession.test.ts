import { describe, expect, it } from 'vitest';
import {
  getCreatedSessionProfileMemoryUpdate,
  getComposerSessionId,
  getComposerSessionLabels,
  getComposerSessionSelectionNotification,
  getComposerScratchTargetId,
  getComposerTopbarVisibility,
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

  it('derives topbar visibility from status, selector, and executor signals', () => {
    expect(
      getComposerTopbarVisibility({
        hasTokenUsageInfo: false,
        hasCodexGoalState: false,
        showSessionSelector: false,
        sessionCount: 0,
        hasExecutorProfile: false,
      })
    ).toBe(false);

    expect(
      getComposerTopbarVisibility({
        hasTokenUsageInfo: true,
        hasCodexGoalState: false,
        showSessionSelector: false,
        sessionCount: 0,
        hasExecutorProfile: false,
      })
    ).toBe(true);

    expect(
      getComposerTopbarVisibility({
        hasTokenUsageInfo: false,
        hasCodexGoalState: true,
        showSessionSelector: false,
        sessionCount: 0,
        hasExecutorProfile: false,
      })
    ).toBe(true);

    expect(
      getComposerTopbarVisibility({
        hasTokenUsageInfo: false,
        hasCodexGoalState: false,
        showSessionSelector: true,
        sessionCount: 2,
        hasExecutorProfile: false,
      })
    ).toBe(true);

    expect(
      getComposerTopbarVisibility({
        hasTokenUsageInfo: false,
        hasCodexGoalState: false,
        showSessionSelector: true,
        sessionCount: 0,
        hasExecutorProfile: true,
      })
    ).toBe(true);
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
            continuityLabel: 'main',
          },
        ],
        selectedSessionId: 's1',
        isNewSessionMode: false,
      })
    ).toEqual({
      selectedSessionLabel: 'Alpha Session \u8def main',
      compactSessionLabel: 'Alpha Se',
    });

    expect(
      getComposerSessionLabels({
        sessions: [{ id: 's1', displayName: 'Alpha', continuityLabel: 'main' }],
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
          { id: 's1', displayName: 'Alpha', continuityLabel: 'main' },
          { id: 's2', displayName: 'Beta', continuityLabel: 'branch' },
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
});

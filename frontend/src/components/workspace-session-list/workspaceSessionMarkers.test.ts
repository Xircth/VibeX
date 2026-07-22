import { describe, expect, it } from 'vitest';
import { workspaceSessionMarkerTone } from './workspaceSessionMarkers';

describe('workspaceSessionMarkerTone', () => {
  const base = {
    workspaceId: 'workspace-1',
    branch: 'feature/session-list',
    activeSessionId: 'active-session',
    activeWorkspaceId: 'workspace-1',
    activeBranch: 'feature/session-list',
  };

  it('reserves red for the active session', () => {
    expect(
      workspaceSessionMarkerTone({ ...base, sessionId: 'active-session' })
    ).toBe('active');
  });

  it('marks the same workspace or worktree branch blue', () => {
    expect(
      workspaceSessionMarkerTone({ ...base, sessionId: 'same-workspace' })
    ).toBe('related');
    expect(
      workspaceSessionMarkerTone({
        ...base,
        sessionId: 'same-branch',
        workspaceId: 'workspace-2',
        branch: 'origin/feature/session-list',
      })
    ).toBe('related');
  });

  it('marks sessions outside the current workspace gray', () => {
    expect(
      workspaceSessionMarkerTone({
        ...base,
        sessionId: 'other',
        workspaceId: 'workspace-2',
        branch: 'feature/other',
      })
    ).toBe('other');
  });
});

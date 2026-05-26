import { describe, expect, it } from 'vitest';
import { getAttemptStoppedRefreshDecision } from './sessionComposerAttempt';

describe('session composer attempt helpers', () => {
  it('refreshes branch state only after a running attempt stops in a workspace', () => {
    expect(
      getAttemptStoppedRefreshDecision({
        wasAttemptRunning: true,
        isAttemptRunning: false,
        hasWorkspace: true,
      })
    ).toEqual({
      shouldRefreshBranchState: true,
      nextWasAttemptRunning: false,
    });

    expect(
      getAttemptStoppedRefreshDecision({
        wasAttemptRunning: true,
        isAttemptRunning: false,
        hasWorkspace: false,
      }).shouldRefreshBranchState
    ).toBe(false);
  });

  it('does not refresh while the attempt is still running or was already stopped', () => {
    expect(
      getAttemptStoppedRefreshDecision({
        wasAttemptRunning: true,
        isAttemptRunning: true,
        hasWorkspace: true,
      })
    ).toEqual({
      shouldRefreshBranchState: false,
      nextWasAttemptRunning: true,
    });

    expect(
      getAttemptStoppedRefreshDecision({
        wasAttemptRunning: false,
        isAttemptRunning: false,
        hasWorkspace: true,
      })
    ).toEqual({
      shouldRefreshBranchState: false,
      nextWasAttemptRunning: false,
    });
  });

  it('always advances the previous-running snapshot to the current attempt state', () => {
    expect(
      getAttemptStoppedRefreshDecision({
        wasAttemptRunning: false,
        isAttemptRunning: true,
        hasWorkspace: true,
      }).nextWasAttemptRunning
    ).toBe(true);

    expect(
      getAttemptStoppedRefreshDecision({
        wasAttemptRunning: true,
        isAttemptRunning: false,
        hasWorkspace: true,
      }).nextWasAttemptRunning
    ).toBe(false);
  });
});

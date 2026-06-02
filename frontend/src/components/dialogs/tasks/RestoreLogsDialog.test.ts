import { describe, expect, it } from 'vitest';
import { getRestoreConfirmDisabled } from './RestoreLogsDialog';

describe('RestoreLogsDialog confirmation gate', () => {
  it('allows confirmation when force reset acknowledges dirty worktree risk', () => {
    expect(
      getRestoreConfirmDisabled({
        isLoading: false,
        anyDirty: true,
        acknowledgeUncommitted: false,
        forceReset: true,
        hasRisk: true,
        worktreeResetOn: true,
        needGitReset: true,
      })
    ).toBe(false);
  });

  it('keeps confirmation blocked for dirty worktrees without acknowledgement or force reset', () => {
    expect(
      getRestoreConfirmDisabled({
        isLoading: false,
        anyDirty: true,
        acknowledgeUncommitted: false,
        forceReset: false,
        hasRisk: true,
        worktreeResetOn: true,
        needGitReset: true,
      })
    ).toBe(true);
  });
});

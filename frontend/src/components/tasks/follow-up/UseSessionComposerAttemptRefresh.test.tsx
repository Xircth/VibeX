import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSessionComposerAttemptRefresh } from './useSessionComposerAttemptRefresh';

describe('useSessionComposerAttemptRefresh', () => {
  it('refreshes branch state only when a running attempt stops in a workspace', () => {
    const refetchBranchStatus = vi.fn();
    const refetchAttemptBranch = vi.fn();

    const { rerender } = renderHook(
      ({
        isAttemptRunning,
        workspaceId,
      }: {
        isAttemptRunning: boolean;
        workspaceId: string | null;
      }) =>
        useSessionComposerAttemptRefresh({
          isAttemptRunning,
          workspaceId,
          refetchBranchStatus,
          refetchAttemptBranch,
        }),
      { initialProps: { isAttemptRunning: true, workspaceId: 'workspace-1' } }
    );

    expect(refetchBranchStatus).not.toHaveBeenCalled();
    expect(refetchAttemptBranch).not.toHaveBeenCalled();

    rerender({ isAttemptRunning: false, workspaceId: 'workspace-1' });

    expect(refetchBranchStatus).toHaveBeenCalledOnce();
    expect(refetchAttemptBranch).toHaveBeenCalledOnce();

    rerender({ isAttemptRunning: false, workspaceId: 'workspace-1' });

    expect(refetchBranchStatus).toHaveBeenCalledOnce();
    expect(refetchAttemptBranch).toHaveBeenCalledOnce();
  });

  it('suppresses stopped-transition refreshes without a workspace', () => {
    const refetchBranchStatus = vi.fn();
    const refetchAttemptBranch = vi.fn();

    const { rerender } = renderHook(
      ({
        isAttemptRunning,
        workspaceId,
      }: {
        isAttemptRunning: boolean;
        workspaceId: string | null;
      }) =>
        useSessionComposerAttemptRefresh({
          isAttemptRunning,
          workspaceId,
          refetchBranchStatus,
          refetchAttemptBranch,
        }),
      { initialProps: { isAttemptRunning: true, workspaceId: null } }
    );

    rerender({ isAttemptRunning: false, workspaceId: null });

    expect(refetchBranchStatus).not.toHaveBeenCalled();
    expect(refetchAttemptBranch).not.toHaveBeenCalled();
  });

  it('advances previous-running state across start and stop cycles', () => {
    const refetchBranchStatus = vi.fn();
    const refetchAttemptBranch = vi.fn();

    const { rerender } = renderHook(
      ({ isAttemptRunning }: { isAttemptRunning: boolean }) =>
        useSessionComposerAttemptRefresh({
          isAttemptRunning,
          workspaceId: 'workspace-1',
          refetchBranchStatus,
          refetchAttemptBranch,
        }),
      { initialProps: { isAttemptRunning: false } }
    );

    rerender({ isAttemptRunning: true });
    rerender({ isAttemptRunning: false });
    rerender({ isAttemptRunning: true });
    rerender({ isAttemptRunning: false });

    expect(refetchBranchStatus).toHaveBeenCalledTimes(2);
    expect(refetchAttemptBranch).toHaveBeenCalledTimes(2);
  });
});

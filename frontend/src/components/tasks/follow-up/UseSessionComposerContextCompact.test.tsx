import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionComposerContextCompact } from './useSessionComposerContextCompact';

const { sendAgentRuntimeTurnMock } = vi.hoisted(() => ({
  sendAgentRuntimeTurnMock: vi.fn(),
}));

vi.mock('@/features/agents/sendAgentRuntimeTurn', () => ({
  sendAgentRuntimeTurn: sendAgentRuntimeTurnMock,
}));

const profile = { executor: 'codex' as const };
type ProcessStub = { id: string; status: string };
const compactSubmission = {
  input: { id: 'input-1' },
  turn: {
    conversationId: 'session-1',
    turnId: 'turn-1',
    status: 'running',
    lastSequence: 1n,
  },
};
const compactEligibility = {
  hasWorkspaceForTyping: true,
  isSendingFollowUp: false,
  isRetryActive: false,
  hasPendingApproval: false,
  isAttemptRunning: false,
  isAwaitingNewSessionConfirmation: false,
  isNewSessionMode: false,
};

describe('useSessionComposerContextCompact', () => {
  beforeEach(() => {
    sendAgentRuntimeTurnMock.mockReset();
    vi.useRealTimers();
  });

  it('suppresses compact requests when the turn input is unavailable', async () => {
    const setFollowUpError = vi.fn();
    const clearStopping = vi.fn();
    const { result } = renderHook(() =>
      useSessionComposerContextCompact({
        sessionId: null,
        workspaceId: 'workspace-1',
        executorProfile: profile,
        processes: [],
        setFollowUpError,
        clearStopping,
        ...compactEligibility,
      })
    );

    await act(async () => {
      await result.current.handleCompactContext();
    });

    expect(sendAgentRuntimeTurnMock).not.toHaveBeenCalled();
    expect(setFollowUpError).not.toHaveBeenCalled();
    expect(clearStopping).not.toHaveBeenCalled();
    expect(result.current.isCompactingContext).toBe(false);
  });

  it('uses hook-owned compact eligibility when compacting', async () => {
    const setFollowUpError = vi.fn();
    const clearStopping = vi.fn();
    sendAgentRuntimeTurnMock.mockResolvedValue(compactSubmission);

    const { result } = renderHook(() =>
      useSessionComposerContextCompact({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        executorProfile: profile,
        processes: [],
        setFollowUpError,
        clearStopping,
        ...compactEligibility,
      })
    );

    await act(async () => {
      await result.current.handleCompactContext();
    });

    expect(sendAgentRuntimeTurnMock).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      executorProfileId: profile,
      text: '/compact',
    });
    expect(clearStopping).toHaveBeenCalledOnce();
  });

  it('sends compact turns and keeps pending state independent from old processes', async () => {
    const setFollowUpError = vi.fn();
    const clearStopping = vi.fn();
    sendAgentRuntimeTurnMock.mockResolvedValue({
      ...compactSubmission,
      turn: { ...compactSubmission.turn, turnId: 'process-1' },
    });

    const { result, rerender } = renderHook(
      ({ processes }: { processes: ProcessStub[] }) =>
        useSessionComposerContextCompact({
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          executorProfile: profile,
          processes,
          setFollowUpError,
          clearStopping,
          ...compactEligibility,
        }),
      { initialProps: { processes: [] as ProcessStub[] } }
    );

    await act(async () => {
      await result.current.handleCompactContext();
    });

    expect(setFollowUpError).toHaveBeenCalledWith(null);
    expect(clearStopping).toHaveBeenCalledOnce();
    expect(sendAgentRuntimeTurnMock).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      executorProfileId: profile,
      text: '/compact',
    });
    expect(result.current.isCompactingContext).toBe(true);

    rerender({ processes: [{ id: 'process-1', status: 'running' }] });

    expect(result.current.isCompactingContext).toBe(true);
  });

  it('clears pending compact state after the timeout window', async () => {
    vi.useFakeTimers();
    sendAgentRuntimeTurnMock.mockResolvedValue(compactSubmission);

    const { result } = renderHook(() =>
      useSessionComposerContextCompact({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        executorProfile: profile,
        processes: [],
        setFollowUpError: vi.fn(),
        clearStopping: vi.fn(),
        ...compactEligibility,
      })
    );

    await act(async () => {
      await result.current.handleCompactContext();
    });
    expect(result.current.isCompactingContext).toBe(true);

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(result.current.isCompactingContext).toBe(false);
  });

  it('maps ACP runtime failures to follow-up errors', async () => {
    const setFollowUpError = vi.fn();
    sendAgentRuntimeTurnMock.mockRejectedValue(new Error('network down'));

    const { result } = renderHook(() =>
      useSessionComposerContextCompact({
        sessionId: 'session-1',
        workspaceId: 'workspace-1',
        executorProfile: profile,
        processes: [],
        setFollowUpError,
        clearStopping: vi.fn(),
        ...compactEligibility,
      })
    );

    await act(async () => {
      await result.current.handleCompactContext();
    });

    expect(setFollowUpError).toHaveBeenLastCalledWith(
      '启动上下文压缩失败：network down'
    );
    expect(result.current.isCompactingContext).toBe(false);
  });
});

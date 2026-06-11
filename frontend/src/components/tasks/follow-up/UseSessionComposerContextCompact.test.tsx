import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent } from 'shared/types';
import { useSessionComposerContextCompact } from './useSessionComposerContextCompact';

const { sendAgentRuntimeTurnMock } = vi.hoisted(() => ({
  sendAgentRuntimeTurnMock: vi.fn(),
}));

vi.mock('@/features/agents/sendAgentRuntimeTurn', () => ({
  sendAgentRuntimeTurn: sendAgentRuntimeTurnMock,
}));

const profile = { executor: BaseCodingAgent.CODEX };
type ProcessStub = { id: string; status: string };
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
    sendAgentRuntimeTurnMock.mockResolvedValue({
      id: 'prompt-1',
    });

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

  it('sends compact turns and clears pending state when the process appears', async () => {
    const setFollowUpError = vi.fn();
    const clearStopping = vi.fn();
    sendAgentRuntimeTurnMock.mockResolvedValue({
      id: 'process-1',
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

    expect(result.current.isCompactingContext).toBe(false);
  });

  it('clears pending compact state after the timeout window', async () => {
    vi.useFakeTimers();
    sendAgentRuntimeTurnMock.mockResolvedValue({
      id: 'prompt-1',
    });

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

  it('maps provider runtime failures to follow-up errors', async () => {
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

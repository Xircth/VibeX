import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAttemptExecution } from './useAttemptExecution';

const mocks = vi.hoisted(() => ({
  cancelConversation: vi.fn(),
  cancelPrompt: vi.fn(),
  setIsStopping: vi.fn(),
  isStopping: false,
  isAttemptRunningVisible: true,
}));

vi.mock('@tanstack/react-query', () => ({
  useQueries: () => [],
}));

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: {
    cancel: mocks.cancelConversation,
  },
}));

vi.mock('@/features/agents/useAgentWorkbench', () => ({
  useAgentWorkbench: () => ({
    sessions: {},
    cancelPrompt: mocks.cancelPrompt,
  }),
}));

vi.mock('@/contexts/ExecutionProcessesContext', () => ({
  useExecutionProcessesContext: () => ({
    executionProcessesVisible: [],
    isAttemptRunningVisible: mocks.isAttemptRunningVisible,
    isLoading: false,
  }),
}));

vi.mock('@/stores/useTaskDetailsUiStore', () => ({
  useTaskStopping: () => ({
    isStopping: mocks.isStopping,
    setIsStopping: mocks.setIsStopping,
  }),
  useStopToastSuppression: () => ({
    markStopToastSuppressed: vi.fn(),
    clearStopToastSuppression: vi.fn(),
  }),
}));

vi.mock('@/lib/api', () => ({
  attemptsApi: { stop: vi.fn() },
  executionProcessesApi: { getDetails: vi.fn() },
}));

describe('useAttemptExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isStopping = false;
    mocks.isAttemptRunningVisible = true;
    mocks.cancelConversation.mockResolvedValue(undefined);
  });

  it('cancels the in-flight conversation through its public turn API', async () => {
    const { result } = renderHook(() =>
      useAttemptExecution(undefined, 'task-1', 'conversation-1')
    );

    await act(async () => {
      await result.current.stopExecution();
    });

    expect(mocks.cancelConversation).toHaveBeenCalledWith({
      conversationId: 'conversation-1',
      reason: '用户请求停止',
    });
    expect(mocks.cancelPrompt).not.toHaveBeenCalled();
  });

  it('keeps isStopping active during cold-start when only isConversationTurnInFlight is true until the turn settles', () => {
    mocks.isAttemptRunningVisible = false;
    mocks.isStopping = true;

    const { result, rerender } = renderHook(
      ({ turnInFlight }: { turnInFlight: boolean }) =>
        useAttemptExecution(
          undefined,
          'task-1',
          'conversation-1',
          turnInFlight
        ),
      { initialProps: { turnInFlight: true } }
    );

    expect(result.current.isAttemptRunning).toBe(true);
    expect(mocks.setIsStopping).not.toHaveBeenCalledWith(false);

    rerender({ turnInFlight: false });
    expect(result.current.isAttemptRunning).toBe(false);
    expect(mocks.setIsStopping).toHaveBeenCalledWith(false);
  });
});

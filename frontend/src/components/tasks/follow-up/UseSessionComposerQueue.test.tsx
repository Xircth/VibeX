import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent, type QueueStatus } from 'shared/types';
import { getQueueStatusQueryKey } from './sessionComposerQueue';
import { useSessionComposerQueue } from './useSessionComposerQueue';

const { sendAgentRuntimeTurnMock } = vi.hoisted(() => ({
  sendAgentRuntimeTurnMock: vi.fn(),
}));

vi.mock('@/features/agents/sendAgentRuntimeTurn', () => ({
  sendAgentRuntimeTurn: sendAgentRuntimeTurnMock,
}));

const profile = { executor: BaseCodingAgent.CODEX };

function queuedStatus(message = 'queued text'): Extract<
  QueueStatus,
  { status: 'queued' }
> {
  return {
    status: 'queued',
    message: {
      session_id: 'session-1',
      queued_at: '2026-05-25T00:00:00.000Z',
      data: {
        message,
        images: ['vibe://queued'],
        executor_config: profile,
        queued: true,
      },
    },
  };
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe('useSessionComposerQueue', () => {
  beforeEach(() => {
    sendAgentRuntimeTurnMock.mockReset();
    sendAgentRuntimeTurnMock.mockResolvedValue({
      id: 'prompt-1',
      session_id: 'session-1',
      status: { kind: 'queued' },
      text_preview: 'next message',
      created_at: '2026-05-25T00:00:00.000Z',
      updated_at: '2026-05-25T00:00:00.000Z',
    });
  });

  it('sends queued prompts through the ACP runtime and writes local queue state', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(getQueueStatusQueryKey('session-1'), queuedStatus('loaded'));

    const { result } = renderHook(
      () =>
        useSessionComposerQueue({
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          isAttemptRunning: true,
          processCount: 1,
        }),
      { wrapper: wrapperFor(queryClient) }
    );

    await waitFor(() => expect(result.current.isQueued).toBe(true));
    expect(result.current.queueIndicatorState).toEqual({
      isQueued: true,
      messagePreview: 'loaded',
      attachmentCount: 1,
    });

    await act(async () => {
      await result.current.queueMessage('next message', profile, [
        'vibe://next-image',
      ]);
    });

    expect(sendAgentRuntimeTurnMock).toHaveBeenCalledWith({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      text: 'next message',
      images: ['vibe://next-image'],
      executorProfileId: profile,
    });
    expect(queryClient.getQueryData(getQueueStatusQueryKey('session-1'))).toMatchObject(
      {
        status: 'queued',
        message: {
          session_id: 'session-1',
          data: {
            message: 'next message',
            images: ['vibe://next-image'],
            executor_config: profile,
            queued: true,
          },
        },
      }
    );

    await act(async () => {
      await result.current.cancelQueue();
    });

    expect(queryClient.getQueryData(getQueueStatusQueryKey('session-1'))).toEqual(
      { status: 'empty' }
    );
  });

  it('suppresses queue and cancel mutations without a session id', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    const { result } = renderHook(
      () =>
        useSessionComposerQueue({
          sessionId: undefined,
          workspaceId: 'workspace-1',
          isAttemptRunning: true,
          processCount: 1,
        }),
      { wrapper: wrapperFor(queryClient) }
    );

    await act(async () => {
      await result.current.queueMessage('next message', profile);
      await result.current.cancelQueue();
    });

    expect(sendAgentRuntimeTurnMock).not.toHaveBeenCalled();
    expect(result.current.queueStatus).toEqual({ status: 'empty' });
  });

  it('reads local queue status when the selected session becomes available', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(getQueueStatusQueryKey('session-1'), queuedStatus('loaded'));

    const { rerender } = renderHook(
      ({ sessionId }: { sessionId: string | undefined }) =>
        useSessionComposerQueue({
          sessionId,
          workspaceId: 'workspace-1',
          isAttemptRunning: true,
          processCount: 1,
        }),
      {
        initialProps: { sessionId: undefined as string | undefined },
        wrapper: wrapperFor(queryClient),
      }
    );

    rerender({ sessionId: 'session-1' });

    await waitFor(() =>
      expect(queryClient.getQueryData(getQueueStatusQueryKey('session-1'))).toEqual(
        queuedStatus('loaded')
      )
    );
  });

  it('refreshes queue status on process-count changes only when the refresh policy allows it', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(getQueueStatusQueryKey('session-1'), queuedStatus('loaded'));

    const { result, rerender } = renderHook(
      ({
        workspaceId,
        isAttemptRunning,
        processCount,
      }: {
        workspaceId: string | undefined;
        isAttemptRunning: boolean;
        processCount: number;
      }) =>
        useSessionComposerQueue({
          sessionId: 'session-1',
          workspaceId,
          isAttemptRunning,
          processCount,
        }),
      {
        initialProps: {
          workspaceId: 'workspace-1' as string | undefined,
          isAttemptRunning: true,
          processCount: 1,
        },
        wrapper: wrapperFor(queryClient),
      }
    );

    rerender({
      workspaceId: undefined,
      isAttemptRunning: true,
      processCount: 2,
    });
    expect(result.current.queueStatus.status).toBe('queued');

    rerender({
      workspaceId: 'workspace-1',
      isAttemptRunning: true,
      processCount: 3,
    });
    await waitFor(() => expect(result.current.queueStatus.status).toBe('queued'));

    rerender({
      workspaceId: 'workspace-1',
      isAttemptRunning: false,
      processCount: 3,
    });
    await waitFor(() => expect(result.current.queueStatus.status).toBe('queued'));
  });
});

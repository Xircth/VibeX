import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent, type QueueStatus } from 'shared/types';
import { getQueueStatusQueryKey } from './sessionComposerQueue';
import { useSessionComposerQueue } from './useSessionComposerQueue';

const { queueMock, cancelMock, getStatusMock } = vi.hoisted(() => ({
  queueMock: vi.fn(),
  cancelMock: vi.fn(),
  getStatusMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  queueApi: {
    queue: queueMock,
    cancel: cancelMock,
    getStatus: getStatusMock,
  },
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
    queueMock.mockReset();
    cancelMock.mockReset();
    getStatusMock.mockReset();
  });

  it('loads queue status and writes queue/cancel mutation results to cache', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    getStatusMock.mockResolvedValue(queuedStatus('loaded'));
    queueMock.mockResolvedValue(queuedStatus('queued later'));
    cancelMock.mockResolvedValue({ status: 'empty' });

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

    await waitFor(() => expect(getStatusMock).toHaveBeenCalledWith('session-1'));
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

    expect(queueMock).toHaveBeenCalledWith('session-1', {
      message: 'next message',
      images: ['vibe://next-image'],
      executor_profile_id: profile,
    });
    expect(queryClient.getQueryData(getQueueStatusQueryKey('session-1'))).toEqual(
      queuedStatus('queued later')
    );

    await act(async () => {
      await result.current.cancelQueue();
    });

    expect(cancelMock).toHaveBeenCalledWith('session-1');
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

    expect(getStatusMock).not.toHaveBeenCalled();
    expect(queueMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
    expect(result.current.queueStatus).toEqual({ status: 'empty' });
  });

  it('refreshes queue status when the selected session becomes available', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    getStatusMock.mockResolvedValue({ status: 'empty' });

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

    expect(getStatusMock).not.toHaveBeenCalled();

    rerender({ sessionId: 'session-1' });

    await waitFor(() => expect(getStatusMock).toHaveBeenCalledWith('session-1'));
  });

  it('refreshes queue status on process-count changes only when the refresh policy allows it', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    getStatusMock.mockResolvedValue({ status: 'empty' });

    const { rerender } = renderHook(
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

    await waitFor(() => expect(getStatusMock).toHaveBeenCalled());
    getStatusMock.mockClear();

    rerender({
      workspaceId: undefined,
      isAttemptRunning: true,
      processCount: 2,
    });
    expect(getStatusMock).not.toHaveBeenCalled();

    rerender({
      workspaceId: 'workspace-1',
      isAttemptRunning: true,
      processCount: 3,
    });
    await waitFor(() => expect(getStatusMock).toHaveBeenCalledTimes(1));

    getStatusMock.mockClear();
    rerender({
      workspaceId: 'workspace-1',
      isAttemptRunning: false,
      processCount: 3,
    });
    await waitFor(() => expect(getStatusMock).toHaveBeenCalledTimes(1));
  });
});

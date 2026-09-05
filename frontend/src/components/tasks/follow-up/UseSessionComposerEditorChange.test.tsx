import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { type ReactNode, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  getQueueStatusQueryKey,
  type QueueStatus,
} from './sessionComposerQueue';
import { useSessionComposerEditorChange } from './useSessionComposerEditorChange';

function queuedStatus(): Extract<QueueStatus, { status: 'queued' }> {
  return {
    status: 'queued',
    messages: [
      {
        id: 'input-1',
        session_id: 'session-1',
        operationId: 'operation-1',
        revision: 1n,
        sortKey: 1024n,
        status: 'queued',
        created_at: '2026-05-25T00:00:00.000Z',
        updated_at: '2026-05-25T00:00:00.000Z',
        executorProfileId: { executor: 'codex', variant: null },
        data: {
          message: 'queued draft',
          images: [],
          pluginActions: [],
        },
      },
    ],
  };
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe('useSessionComposerEditorChange', () => {
  it('keeps queued drafts intact while updating local state and clearing errors', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      getQueueStatusQueryKey('session-1'),
      queuedStatus()
    );
    const setFollowUpError = vi.fn();
    const setFollowUpMessage = vi.fn();
    const { result } = renderHook(
      () => {
        const [localMessage, setLocalMessage] = useState('initial');
        const { handleEditorChange } = useSessionComposerEditorChange({
          sessionId: 'session-1',
          followUpError: 'previous error',
          setFollowUpError,
          setLocalMessage,
          setFollowUpMessage,
        });

        return { handleEditorChange, localMessage };
      },
      { wrapper: wrapperFor(queryClient) }
    );

    act(() => {
      result.current.handleEditorChange('next draft');
    });

    expect(result.current.localMessage).toBe('next draft');
    expect(setFollowUpMessage).not.toHaveBeenCalled();
    expect(setFollowUpError).toHaveBeenCalledWith(null);
  });

  it('suppresses queue cancellation and error clearing when no queued draft or error exists', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(getQueueStatusQueryKey('session-1'), {
      status: 'empty',
    });
    const setFollowUpError = vi.fn();
    const setFollowUpMessage = vi.fn();
    const { result } = renderHook(
      () => {
        const [localMessage, setLocalMessage] = useState('initial');
        const { handleEditorChange } = useSessionComposerEditorChange({
          sessionId: 'session-1',
          followUpError: null,
          setFollowUpError,
          setLocalMessage,
          setFollowUpMessage,
        });

        return { handleEditorChange, localMessage };
      },
      { wrapper: wrapperFor(queryClient) }
    );

    act(() => {
      result.current.handleEditorChange('plain draft');
    });

    expect(result.current.localMessage).toBe('plain draft');
    expect(setFollowUpMessage).toHaveBeenCalledWith('plain draft');
    expect(setFollowUpError).not.toHaveBeenCalled();
  });

  it('uses the latest draft message setter after rerender', () => {
    const queryClient = new QueryClient();
    const firstSetFollowUpMessage = vi.fn();
    const secondSetFollowUpMessage = vi.fn();

    const { result, rerender } = renderHook(
      ({
        setFollowUpMessage,
      }: {
        setFollowUpMessage: (message: string) => void;
      }) => {
        const [localMessage, setLocalMessage] = useState('initial');
        const { applyDraftMessage, handleEditorChange } =
          useSessionComposerEditorChange({
            sessionId: 'session-1',
            followUpError: null,
            setFollowUpError: vi.fn(),
            setLocalMessage,
            setFollowUpMessage,
          });

        return { applyDraftMessage, handleEditorChange, localMessage };
      },
      {
        initialProps: { setFollowUpMessage: firstSetFollowUpMessage },
        wrapper: wrapperFor(queryClient),
      }
    );

    rerender({ setFollowUpMessage: secondSetFollowUpMessage });

    act(() => {
      result.current.applyDraftMessage('applied draft');
    });
    act(() => {
      result.current.handleEditorChange('edited draft');
    });

    expect(firstSetFollowUpMessage).not.toHaveBeenCalled();
    expect(secondSetFollowUpMessage).toHaveBeenCalledWith('applied draft');
    expect(secondSetFollowUpMessage).toHaveBeenCalledWith('edited draft');
    expect(result.current.localMessage).toBe('edited draft');
  });
});

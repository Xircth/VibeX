import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationInputView } from 'shared/types';
import { useSessionComposerQueue } from './useSessionComposerQueue';

const api = vi.hoisted(() => ({
  listInputs: vi.fn(),
  submitInput: vi.fn(),
  updateInput: vi.fn(),
  cancelInput: vi.fn(),
  reorderInput: vi.fn(),
}));
const listenToConversationEventsMock = vi.hoisted(() => vi.fn());

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: api,
}));
vi.mock('@/features/conversation/events', () => ({
  listenToConversationEvents: listenToConversationEventsMock,
}));

const profile = { executor: 'codex' as const };

function input(
  id = 'input-1',
  sortKey = 1024n,
  status: ConversationInputView['status'] = 'queued'
): ConversationInputView {
  return {
    id,
    conversationId: 'session-1',
    operationId: `operation-${id}`,
    revision: 1n,
    sortKey,
    status,
    payload: {
      agentId: 'codex',
      workspaceId: 'workspace-1',
      executorProfileId: profile,
      text: `${id} agent text`,
      displayText: `${id} visible text`,
      images: [],
    },
    principal: { kind: 'local_desktop' },
    claimToken: status === 'claimed' ? 'claim-1' : null,
    claimDeadline: null,
    turnId: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  };
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function client() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

describe('useSessionComposerQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenToConversationEventsMock.mockResolvedValue(() => {});
    api.listInputs.mockResolvedValue([]);
    api.submitInput.mockImplementation(async () => input());
    api.updateInput.mockImplementation(async () => ({
      ...input(),
      revision: 2n,
    }));
    api.cancelInput.mockImplementation(async () => ({
      ...input(),
      status: 'cancelled',
    }));
    api.reorderInput.mockImplementation(async () => input());
  });

  it('hydrates every queued input from the backend projection', async () => {
    api.listInputs.mockResolvedValue([
      input('input-1', 1024n),
      input('input-2', 2048n, 'claimed'),
      input('input-3', 3072n, 'cancelled'),
    ]);
    const { result } = renderHook(
      () =>
        useSessionComposerQueue({
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          isAttemptRunning: true,
        }),
      { wrapper: wrapperFor(client()) }
    );

    await waitFor(() => expect(result.current.queuedMessages).toHaveLength(2));
    expect(result.current.queuedMessages.map((message) => message.id)).toEqual([
      'input-1',
      'input-2',
    ]);
    expect(api.listInputs).toHaveBeenCalledWith('session-1');
  });

  it('submits canonical payload to ConversationControl without a client dispatch effect', async () => {
    const { result } = renderHook(
      () =>
        useSessionComposerQueue({
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          isAttemptRunning: true,
          modeOverride: 'plan',
          configOverrides: [{ key: 'model', value: 'gpt-5.4' }],
        }),
      { wrapper: wrapperFor(client()) }
    );

    await act(async () => {
      await result.current.queueMessage(
        'visible',
        profile,
        ['vibe://image'],
        [],
        'agent text'
      );
    });

    expect(api.submitInput).toHaveBeenCalledWith(
      'session-1',
      {
        agentId: 'codex',
        workspaceId: 'workspace-1',
        executorProfileId: profile,
        text: 'agent text',
        displayText: 'visible',
        images: ['vibe://image'],
        workflowRefs: [],
        modeOverride: 'plan',
        configOverrides: [{ key: 'model', value: 'gpt-5.4' }],
        fileRefs: [],
      },
      expect.any(String)
    );
  });

  it('reuses the same operation id when queue persist times out', async () => {
    api.submitInput
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(input());
    const { result } = renderHook(
      () =>
        useSessionComposerQueue({
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          isAttemptRunning: true,
        }),
      { wrapper: wrapperFor(client()) }
    );

    await act(async () => {
      await result.current.queueMessage('visible', profile).catch(() => {});
    });
    await act(async () => {
      await result.current.queueMessage('visible', profile);
    });

    expect(api.submitInput).toHaveBeenCalledTimes(2);
    expect(api.submitInput.mock.calls[0]?.[2]).toEqual(expect.any(String));
    expect(api.submitInput.mock.calls[1]?.[2]).toBe(
      api.submitInput.mock.calls[0]?.[2]
    );
  });

  it('cancels and reorders the selected durable input with its revision', async () => {
    api.listInputs.mockResolvedValue([
      input('input-1', 1024n),
      input('input-2', 2048n),
    ]);
    const { result } = renderHook(
      () =>
        useSessionComposerQueue({
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          isAttemptRunning: true,
        }),
      { wrapper: wrapperFor(client()) }
    );
    await waitFor(() => expect(result.current.queuedMessages).toHaveLength(2));

    await act(async () => {
      await result.current.cancelQueue(result.current.queuedMessages[0]);
    });
    expect(api.cancelInput).toHaveBeenCalledWith({
      conversationId: 'session-1',
      inputId: 'input-1',
      expectedRevision: 1,
    });

    await act(async () => {
      await result.current.moveQueue(result.current.queuedMessages[0], 1);
    });
    expect(api.reorderInput).toHaveBeenNthCalledWith(1, {
      conversationId: 'session-1',
      inputId: 'input-1',
      expectedRevision: 1,
      sortKey: 3072,
    });
    expect(api.reorderInput).toHaveBeenCalledTimes(1);
  });

  it('edits a queued item in place instead of replacing its identity', async () => {
    api.listInputs.mockResolvedValue([input()]);
    const { result } = renderHook(
      () =>
        useSessionComposerQueue({
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          isAttemptRunning: true,
        }),
      { wrapper: wrapperFor(client()) }
    );
    await waitFor(() => expect(result.current.queuedMessages).toHaveLength(1));

    act(() => result.current.beginEditQueue(result.current.queuedMessages[0]));
    await act(async () => {
      await result.current.queueMessage('edited', profile);
    });

    expect(api.updateInput).toHaveBeenCalledWith({
      conversationId: 'session-1',
      inputId: 'input-1',
      expectedRevision: 1,
      payload: expect.objectContaining({
        displayText: 'edited',
        text: 'edited',
      }),
    });
    expect(api.submitInput).not.toHaveBeenCalled();
  });

  it('refreshes the queue when conversation events arrive for the same session', async () => {
    let onBatch: ((batch: { conversation_id: string }) => void) | undefined;
    listenToConversationEventsMock.mockImplementation(async (handler) => {
      onBatch = handler;
      return () => {};
    });
    api.listInputs
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([input('input-2', 2048n)]);
    const { result } = renderHook(
      () =>
        useSessionComposerQueue({
          sessionId: 'session-1',
          workspaceId: 'workspace-1',
          isAttemptRunning: false,
        }),
      { wrapper: wrapperFor(client()) }
    );

    await waitFor(() => expect(result.current.queuedMessages).toHaveLength(0));
    await act(async () => {
      onBatch?.({ conversation_id: 'session-1' });
    });
    await waitFor(() => expect(result.current.queuedMessages).toHaveLength(1));
    expect(result.current.queuedMessages[0]?.id).toBe('input-2');
  });
});

import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createMock, sendTurnMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  sendTurnMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  sessionsApi: { create: createMock },
}));

vi.mock('@/features/agents/sendAgentRuntimeTurn', () => ({
  sendAgentRuntimeTurn: sendTurnMock,
}));

import { useFollowUpSend } from './useFollowUpSend';
import {
  subscribeToOptimisticConversationTurns,
  type OptimisticConversationTurnEvent,
} from '@/features/conversation/optimisticTurnEvents';
import { formatSessionComposerCommand } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';

function renderFollowUpSend() {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  return renderHook(
    () =>
      useFollowUpSend({
        sessionId: undefined,
        workspaceId: 'ws-1',
        isNewSessionMode: true,
        message: '你好',
        executorProfileId: { executor: 'codex' as const } as never,
        conflictMarkdown: null,
        reviewMarkdown: '',
        clearComments: vi.fn(),
        onAfterSendCleanup: vi.fn(),
        onSelectSession: vi.fn(),
        onSessionCreated: vi.fn(),
      }),
    { wrapper }
  );
}

describe('useFollowUpSend', () => {
  beforeEach(() => {
    createMock.mockReset();
    sendTurnMock.mockReset();
  });

  it('creates a session and sends the turn exactly once for one message', async () => {
    let resolveCreate: (value: {
      id: string;
      workspace_id: string;
    }) => void = () => {};
    createMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      })
    );
    sendTurnMock.mockResolvedValue({});

    const { result } = renderFollowUpSend();

    // The first invocation is awaiting `sessionsApi.create`; a re-entrant
    // callback at the same acceptance boundary must be a no-op.
    await act(async () => {
      void result.current.onSendFollowUp();
      void result.current.onSendFollowUp();
      await Promise.resolve();
    });

    expect(createMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreate({ id: 'sess-1', workspace_id: 'ws-1' });
      await Promise.resolve();
    });

    await waitFor(() => expect(sendTurnMock).toHaveBeenCalledTimes(1));
  });

  it('publishes the optimistic user turn before the runtime request settles', async () => {
    sendTurnMock.mockReturnValue(new Promise(() => {}));
    const onBeforeSend = vi.fn();
    const events: OptimisticConversationTurnEvent[] = [];
    const unsubscribe = subscribeToOptimisticConversationTurns((event) =>
      events.push(event)
    );
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useFollowUpSend({
          sessionId: 'conversation-1',
          workspaceId: 'ws-1',
          message: '立即显示等待状态',
          executorProfileId: { executor: 'codex' as const } as never,
          conflictMarkdown: null,
          reviewMarkdown: '',
          clearComments: vi.fn(),
          onAfterSendCleanup: vi.fn(),
          onBeforeSend,
        }),
      { wrapper }
    );

    try {
      act(() => {
        void result.current.onSendFollowUp();
      });

      expect(events).toEqual([
        expect.objectContaining({
          type: 'add',
          conversationId: 'conversation-1',
          turn: expect.objectContaining({
            role: 'user',
            blocks: [{ type: 'text', text: '立即显示等待状态' }],
          }),
        }),
      ]);
      expect(onBeforeSend).toHaveBeenCalledOnce();
    } finally {
      unsubscribe();
    }
  });

  it('invalidates the existing session list after its first turn starts', async () => {
    sendTurnMock.mockResolvedValue({});
    const queryClient = new QueryClient();
    const summariesKey = ['workspaceSessions', 'ws-1', 'summaries'];
    queryClient.setQueryData(summariesKey, [
      {
        id: 'conversation-1',
        first_prompt: null,
        display_name: '新会话',
      },
    ]);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useFollowUpSend({
          sessionId: 'conversation-1',
          workspaceId: 'ws-1',
          message: '修复会话标题功能',
          executorProfileId: { executor: 'codex' as const } as never,
          conflictMarkdown: null,
          reviewMarkdown: '',
          clearComments: vi.fn(),
          onAfterSendCleanup: vi.fn(),
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.onSendFollowUp();
    });

    expect(queryClient.getQueryState(summariesKey)?.isInvalidated).toBe(true);
  });

  it('sends the composer value supplied by the Enter submission frame', async () => {
    sendTurnMock.mockResolvedValue({});
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useFollowUpSend({
          sessionId: 'conversation-1',
          workspaceId: 'ws-1',
          message: 'stale draft',
          executorProfileId: { executor: 'codex' as const } as never,
          conflictMarkdown: null,
          reviewMarkdown: '',
          clearComments: vi.fn(),
          onAfterSendCleanup: vi.fn(),
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.onSubmitFollowUp('current composer text');
    });

    expect(sendTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'current composer text',
        displayText: 'current composer text',
      })
    );
  });

  it('sends a skill token by full path while preserving its structured display text', async () => {
    sendTurnMock.mockResolvedValue({});
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const tokenizedMessage = `${formatSessionComposerCommand({
      type: '/',
      key: 'skill:/Users/mac/.codex/skills/drawio/drawio:drawio',
      value: '/skill:/Users/mac/.codex/skills/drawio/drawio:drawio',
    })} draw the architecture`;
    const { result } = renderHook(
      () =>
        useFollowUpSend({
          sessionId: 'conversation-1',
          workspaceId: 'ws-1',
          message: tokenizedMessage,
          executorProfileId: { executor: 'codex' as const } as never,
          conflictMarkdown: null,
          reviewMarkdown: '',
          clearComments: vi.fn(),
          onAfterSendCleanup: vi.fn(),
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.onSendFollowUp();
    });

    expect(sendTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '/skill:/Users/mac/.codex/skills/drawio/drawio:drawio draw the architecture',
        displayText: tokenizedMessage,
      })
    );
  });

  it('restores the accepted draft when the runtime rejects the turn', async () => {
    sendTurnMock.mockRejectedValue(new Error('runtime unavailable'));
    const onBeforeSend = vi.fn();
    const onSendFailure = vi.fn();
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useFollowUpSend({
          sessionId: 'conversation-1',
          workspaceId: 'ws-1',
          message: 'keep this draft',
          executorProfileId: { executor: 'codex' as const } as never,
          conflictMarkdown: null,
          reviewMarkdown: '',
          clearComments: vi.fn(),
          onBeforeSend,
          onSendFailure,
          onAfterSendCleanup: vi.fn(),
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.onSendFollowUp();
    });

    expect(onBeforeSend).toHaveBeenCalledOnce();
    expect(onSendFailure).toHaveBeenCalledWith('keep this draft');
  });

  it('sends stable agent mention URIs unchanged to the parent agent', async () => {
    sendTurnMock.mockResolvedValue({});
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const message =
      'Compare [&Codex](vibex://agent/codex) and [&Claude Code](vibex://agent/claude_code)';
    const { result } = renderHook(
      () =>
        useFollowUpSend({
          sessionId: 'conversation-1',
          workspaceId: 'ws-1',
          message,
          executorProfileId: { executor: 'codex' as const } as never,
          conflictMarkdown: null,
          reviewMarkdown: '',
          clearComments: vi.fn(),
          onAfterSendCleanup: vi.fn(),
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.onSendFollowUp();
    });

    expect(sendTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ text: message })
    );
  });

  it('reuses the same operation id when the first submit times out', async () => {
    sendTurnMock
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({});
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useFollowUpSend({
          sessionId: 'conversation-1',
          workspaceId: 'ws-1',
          message: 'retry this send',
          executorProfileId: { executor: 'codex' as const } as never,
          conflictMarkdown: null,
          reviewMarkdown: '',
          clearComments: vi.fn(),
          onAfterSendCleanup: vi.fn(),
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.onSendFollowUp();
    });
    await act(async () => {
      await result.current.onSendFollowUp();
    });

    expect(sendTurnMock).toHaveBeenCalledTimes(2);
    const firstOperationId = sendTurnMock.mock.calls[0]?.[0]?.operationId;
    const secondOperationId = sendTurnMock.mock.calls[1]?.[0]?.operationId;
    expect(firstOperationId).toEqual(expect.any(String));
    expect(secondOperationId).toBe(firstOperationId);
  });

  it('sends PluginAction identity with its editable prompt text', async () => {
    sendTurnMock.mockResolvedValue({});
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const action = formatSessionComposerCommand({
      type: '!',
      key: 'vibex.office/create-presentation|创建 PPT',
      value: '',
    });
    const { result } = renderHook(
      () =>
        useFollowUpSend({
          sessionId: 'conversation-1',
          workspaceId: 'ws-1',
          message: `${action}请把重点改成季度复盘`,
          executorProfileId: { executor: 'codex' as const } as never,
          conflictMarkdown: null,
          reviewMarkdown: '',
          clearComments: vi.fn(),
          onAfterSendCleanup: vi.fn(),
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.onSendFollowUp();
    });

    expect(sendTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '请把重点改成季度复盘',
        pluginActions: [
          {
            pluginId: 'vibex.office',
            actionId: 'create-presentation',
          },
        ],
      })
    );
  });
});

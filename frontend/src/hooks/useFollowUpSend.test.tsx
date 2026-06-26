import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { BaseCodingAgent } from 'shared/types';

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
        executorProfileId: { executor: BaseCodingAgent.CODEX } as never,
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

    // Simulate a single Enter reaching the callback twice (global hotkey hook +
    // editor onSubmit). The first invocation is awaiting `sessionsApi.create`;
    // the synchronous re-entrancy guard must make the second invocation a no-op.
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
});

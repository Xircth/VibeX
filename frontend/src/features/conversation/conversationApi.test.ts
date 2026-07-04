import { beforeEach, describe, expect, it, vi } from 'vitest';
import { conversationApi } from './conversationApi';

const { tauriInvokeMock } = vi.hoisted(() => ({
  tauriInvokeMock: vi.fn(),
}));

vi.mock('@/lib/tauriApi', () => ({
  tauriInvoke: tauriInvokeMock,
}));

describe('conversationApi', () => {
  beforeEach(() => {
    tauriInvokeMock.mockReset();
  });

  it('starts turns through conversation_start_turn', async () => {
    tauriInvokeMock.mockResolvedValue({
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      status: 'running',
      lastSequence: 1n,
    });

    await conversationApi.startTurn({
      agentType: 'codex' as const,
      workspaceId: 'workspace-1',
      conversationId: 'conversation-1',
      text: 'hello',
    });

    expect(tauriInvokeMock).toHaveBeenCalledWith('conversation_start_turn', {
      request: {
        agentType: 'codex' as const,
        workspaceId: 'workspace-1',
        conversationId: 'conversation-1',
        text: 'hello',
        images: [],
      },
    });
  });

  it('requests durable events by sequence', async () => {
    tauriInvokeMock.mockResolvedValue({
      conversation_id: 'conversation-1',
      after_sequence: 4n,
      last_sequence: 4n,
      has_more: false,
      events: [],
    });

    await conversationApi.eventsSince({
      conversationId: 'conversation-1',
      afterSequence: 4n,
      limit: 100,
    });

    const [, args] = tauriInvokeMock.mock.calls[0];
    expect(() => JSON.stringify(args)).not.toThrow();
    expect(tauriInvokeMock).toHaveBeenCalledWith('conversation_events_since', {
      request: {
        conversationId: 'conversation-1',
        afterSequence: 4,
        limit: 100,
      },
    });
  });
});

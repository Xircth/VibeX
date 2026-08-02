import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendTransport } from '@/lib/backendTransport';
import { createConversationApi } from './conversationApi';

const call = vi.fn();
const transport: BackendTransport = { environment: 'desktop', call };
const conversationApi = createConversationApi(transport);

describe('conversationApi', () => {
  beforeEach(() => {
    call.mockReset();
  });

  it('creates conversations through the transport-neutral command', async () => {
    call.mockResolvedValue({ id: 'conversation-1' });

    await conversationApi.create({
      workspaceId: 'workspace-1',
      agentId: 'codex',
      title: 'Remote work',
      initialPrompt: 'Draft the plan',
    });

    expect(call).toHaveBeenCalledWith('conversation_create', {
      workspaceId: 'workspace-1',
      agentId: 'codex',
      title: 'Remote work',
      initialPrompt: 'Draft the plan',
    });
  });

  it('starts turns through conversation_start_turn', async () => {
    call.mockResolvedValue({
      conversationId: 'conversation-1',
      turnId: 'turn-1',
      status: 'running',
      lastSequence: 1n,
    });

    await conversationApi.startTurn({
      agentId: 'codex',
      workspaceId: 'workspace-1',
      conversationId: 'conversation-1',
      text: 'hello',
    });

    expect(call).toHaveBeenCalledWith('conversation_start_turn', {
      request: {
        agentId: 'codex',
        workspaceId: 'workspace-1',
        conversationId: 'conversation-1',
        text: 'hello',
        images: [],
      },
    });
  });

  it('requests durable events by sequence', async () => {
    call.mockResolvedValue({
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

    const [, args] = call.mock.calls[0];
    expect(() => JSON.stringify(args)).not.toThrow();
    expect(call).toHaveBeenCalledWith('conversation_events_since', {
      request: {
        conversationId: 'conversation-1',
        afterSequence: 4,
        limit: 100,
      },
    });
  });
});

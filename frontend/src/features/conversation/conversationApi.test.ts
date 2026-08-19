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
      workflowRefs: [
        {
          pluginId: 'vibex.office',
          workflowId: 'create-presentation',
        },
      ],
    });

    expect(call).toHaveBeenCalledWith('conversation_start_turn', {
      request: {
        agentId: 'codex',
        workspaceId: 'workspace-1',
        conversationId: 'conversation-1',
        text: 'hello',
        images: [],
        workflowRefs: [
          {
            pluginId: 'vibex.office',
            workflowId: 'create-presentation',
          },
        ],
      },
    });
  });

  it('submits and lists durable conversation inputs through application commands', async () => {
    call.mockResolvedValueOnce({ id: 'input-1', status: 'queued' });
    const payload = {
      agentId: 'codex',
      workspaceId: 'workspace-1',
      text: 'follow up',
    } as const;

    await conversationApi.submitInput('conversation-1', payload);

    expect(call).toHaveBeenLastCalledWith('conversation_input_submit', {
      request: { conversationId: 'conversation-1', payload },
    });

    await conversationApi.submitInput('conversation-1', payload, 'op-stable-1');
    expect(call).toHaveBeenLastCalledWith(
      'conversation_input_submit',
      { request: { conversationId: 'conversation-1', payload } },
      { operationId: 'op-stable-1' }
    );

    call.mockResolvedValueOnce([]);
    await conversationApi.listInputs('conversation-1');
    expect(call).toHaveBeenLastCalledWith('conversation_input_list', {
      request: { conversationId: 'conversation-1' },
    });
  });

  it('steers only an explicitly expected active turn', async () => {
    call.mockResolvedValue({ status: 'accepted' });

    await conversationApi.steer({
      conversationId: 'conversation-1',
      expectedTurnId: 'turn-1',
      text: 'Focus on the failing test',
      images: [],
    });

    expect(call).toHaveBeenCalledWith('conversation_steer', {
      request: {
        conversationId: 'conversation-1',
        expectedTurnId: 'turn-1',
        text: 'Focus on the failing test',
        images: [],
      },
    });
  });

  it('mutates durable inputs with explicit optimistic revisions', async () => {
    call.mockResolvedValue({ id: 'input-1', status: 'queued' });
    const payload = {
      agentId: 'codex',
      workspaceId: 'workspace-1',
      text: 'edited',
    } as const;

    await conversationApi.updateInput({
      conversationId: 'conversation-1',
      inputId: 'input-1',
      expectedRevision: 1,
      payload,
    });
    expect(call).toHaveBeenLastCalledWith('conversation_input_update', {
      request: {
        conversationId: 'conversation-1',
        inputId: 'input-1',
        expectedRevision: 1,
        payload,
      },
    });

    await conversationApi.reorderInput({
      conversationId: 'conversation-1',
      inputId: 'input-1',
      expectedRevision: 2,
      sortKey: 2048,
    });
    expect(call).toHaveBeenLastCalledWith('conversation_input_reorder', {
      request: {
        conversationId: 'conversation-1',
        inputId: 'input-1',
        expectedRevision: 2,
        sortKey: 2048,
      },
    });

    await conversationApi.cancelInput({
      conversationId: 'conversation-1',
      inputId: 'input-1',
      expectedRevision: 3,
    });
    expect(call).toHaveBeenLastCalledWith('conversation_input_cancel', {
      request: {
        conversationId: 'conversation-1',
        inputId: 'input-1',
        expectedRevision: 3,
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

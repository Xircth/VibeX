import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useConversationTimeline } from './useConversationTimeline';
import type { ConversationEventEnvelope, DbConversationDetail } from 'shared/types';

const { detailMock, listenMock, listeners } = vi.hoisted(() => {
  const listeners = [] as Array<(event: ConversationEventEnvelope) => void>;
  return {
    listeners,
    detailMock: vi.fn(),
    listenMock: vi.fn((handler: (event: ConversationEventEnvelope) => void) => {
      listeners.push(handler);
      return Promise.resolve(() => {});
    }),
  };
});

vi.mock('./conversationApi', () => ({
  conversationApi: {
    detail: detailMock,
    eventsSince: vi.fn(),
    cancel: vi.fn(),
    respondPermission: vi.fn(),
  },
}));

vi.mock('./events', () => ({
  listenToConversationEvents: listenMock,
}));

function detail(): DbConversationDetail {
  return {
    summary: {
      id: 'conversation-1',
      workspace_id: 'workspace-1',
      task_id: null,
      title: 'Conversation',
      title_locked: false,
      status: 'inprogress',
      agent_type: 'codex',
      model: null,
      external_session_id: null,
      message_count: 0n,
      pinned_at: null,
      parent_session_id: null,
      parent_tool_use_id: null,
      delegation_call_id: null,
      created_at: '2026-06-14T00:00:00.000Z',
      updated_at: '2026-06-14T00:00:00.000Z',
    },
    turns: [],
    timeline: {
      conversation_id: 'conversation-1',
      projection_version: 1,
      last_sequence: 0n,
      rows: [],
    },
    projection_version: 1,
  };
}

function event(sequence: bigint): ConversationEventEnvelope {
  return {
    id: `event-${sequence}`,
    conversation_id: 'conversation-1',
    turn_id: 'turn-1',
    sequence,
    source: 'acp',
    created_at: '2026-06-14T00:00:00.000Z',
    event: {
      kind: 'assistant_text_delta',
      text: 'hello',
      message_id: null,
    },
  };
}

describe('useConversationTimeline', () => {
  it('loads projected detail and applies conversation events', async () => {
    listeners.length = 0;
    detailMock.mockResolvedValue(detail());

    const { result } = renderHook(() =>
      useConversationTimeline('conversation-1')
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      listeners[0]?.(event(1n));
    });

    await waitFor(() => expect(result.current.timeline).toHaveLength(1));
    expect(result.current.timeline[0].turn.role).toBe('assistant');
  });
});

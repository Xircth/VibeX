import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DbConversationDetail, DbConversationSummary } from 'shared/types';
import type { AgentEventEnvelope } from './types';
import { useConversationRuntime } from './useConversationRuntime';
import { agentsApi } from './api';

vi.mock('./api', () => ({
  agentsApi: { conversationDetail: vi.fn() },
}));

function event(
  sequence: number,
  evt: AgentEventEnvelope['event']
): AgentEventEnvelope {
  return {
    sequence,
    workspace_id: 'workspace',
    connection_id: 'connection',
    session_id: 'session',
    created_at: `2026-06-11T00:00:0${sequence}.000Z`,
    event: evt,
  };
}

function promptStarted(
  seq: number,
  id: string,
  text: string
): AgentEventEnvelope {
  return event(seq, {
    kind: 'prompt_started',
    snapshot: {
      id,
      session_id: 'session',
      status: { kind: 'running' },
      text_preview: text,
      created_at: `2026-06-11T00:00:0${seq}.000Z`,
      updated_at: `2026-06-11T00:00:0${seq}.000Z`,
    },
  });
}

function detailWith(
  turns: DbConversationDetail['turns']
): DbConversationDetail {
  return {
    summary: {} as unknown as DbConversationSummary,
    turns,
    session_stats: null,
    in_flight_user_turn_id: null,
  };
}

describe('useConversationRuntime', () => {
  it('cold-opens by re-parsing the persisted transcript', async () => {
    vi.mocked(agentsApi.conversationDetail).mockResolvedValue(
      detailWith([
        { id: 'u1', role: 'user', blocks: [], timestamp: '' },
        { id: 'a1', role: 'assistant', blocks: [], timestamp: '' },
      ])
    );

    const { result } = renderHook(() =>
      useConversationRuntime({ conversationId: 'c', events: [] })
    );

    await waitFor(() => expect(result.current.detailLoading).toBe(false));
    expect(result.current.timeline.map((entry) => entry.turn.id)).toEqual([
      'u1',
      'a1',
    ]);
    expect(
      result.current.timeline.every((entry) => entry.phase === 'persisted')
    ).toBe(true);
  });

  it('shows the optimistic user turn and streaming reply while active', async () => {
    vi.mocked(agentsApi.conversationDetail).mockResolvedValue(null);
    const events: AgentEventEnvelope[] = [
      promptStarted(1, 'p1', 'Hello?'),
      event(2, { kind: 'message_chunk', content: { kind: 'text', text: 'Hi there' } }),
    ];

    const { result } = renderHook(() =>
      useConversationRuntime({ conversationId: 'c', events })
    );

    await waitFor(() => expect(result.current.detailLoading).toBe(false));
    expect(
      result.current.timeline.map((entry) => [entry.phase, entry.turn.role])
    ).toEqual([
      ['optimistic', 'user'],
      ['streaming', 'assistant'],
    ]);
  });
});

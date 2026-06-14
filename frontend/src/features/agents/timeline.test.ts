import { describe, expect, it } from 'vitest';
import type { ContentBlock, MessageTurn, TurnRole } from 'shared/types';
import type { AgentEventEnvelope } from './types';
import {
  buildStreamingTurns,
  getTimelineTurns,
  type StreamingTurns,
} from './timeline';

function turn(
  id: string,
  role: TurnRole,
  blocks: ContentBlock[] = []
): MessageTurn {
  return { id, role, blocks, timestamp: '2026-06-11T00:00:00.000Z' };
}

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

function promptStarted(seq: number, id: string): AgentEventEnvelope {
  return event(seq, {
    kind: 'prompt_started',
    snapshot: {
      id,
      session_id: 'session',
      status: { kind: 'running' },
      text_preview: 'hi',
      created_at: `2026-06-11T00:00:0${seq}.000Z`,
      updated_at: `2026-06-11T00:00:0${seq}.000Z`,
    },
  });
}

describe('getTimelineTurns', () => {
  it('flattens phases in persisted/optimistic/streaming order', () => {
    const streaming: StreamingTurns = {
      turns: [turn('live-1', 'assistant')],
      inProgressToolCallIds: new Set(),
    };
    const timeline = getTimelineTurns({
      conversationId: 'c',
      persisted: [turn('u1', 'user'), turn('a1', 'assistant')],
      optimistic: [turn('u2', 'user')],
      streaming,
    });

    expect(timeline.map((entry) => [entry.turn.id, entry.phase])).toEqual([
      ['u1', 'persisted'],
      ['a1', 'persisted'],
      ['u2', 'optimistic'],
      ['live-1', 'streaming'],
    ]);
  });

  it('keeps the last occurrence of an assistant turn (streaming wins over local)', () => {
    const timeline = getTimelineTurns({
      conversationId: 'c',
      persisted: [],
      local: [turn('shared', 'assistant', [{ type: 'text', text: 'old' }])],
      streaming: {
        turns: [turn('shared', 'assistant', [{ type: 'text', text: 'new' }])],
        inProgressToolCallIds: new Set(),
      },
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0].phase).toBe('streaming');
    expect(timeline[0].turn.blocks).toEqual([{ type: 'text', text: 'new' }]);
  });

  it('keeps the first occurrence of a user turn (persisted wins over optimistic)', () => {
    const timeline = getTimelineTurns({
      conversationId: 'c',
      persisted: [turn('uX', 'user')],
      optimistic: [turn('uX', 'user')],
    });

    expect(timeline).toHaveLength(1);
    expect(timeline[0].phase).toBe('persisted');
  });

  it('suppresses the stale persisted partial after the in-flight user turn', () => {
    const timeline = getTimelineTurns({
      conversationId: 'c',
      persisted: [turn('IF', 'user'), turn('stale', 'assistant')],
      streaming: {
        turns: [turn('live', 'assistant')],
        inProgressToolCallIds: new Set(),
      },
      inFlightUserTurnId: 'IF',
    });

    expect(timeline.map((entry) => entry.turn.id)).toEqual(['IF', 'live']);
  });
});

describe('buildStreamingTurns', () => {
  it('folds the active prompt events into one in-flight assistant turn', () => {
    const envelopes: AgentEventEnvelope[] = [
      promptStarted(1, 'p1'),
      event(2, { kind: 'message_chunk', content: { kind: 'text', text: 'Hello ' } }),
      event(3, { kind: 'message_chunk', content: { kind: 'text', text: 'world' } }),
      event(4, {
        kind: 'tool_call',
        tool_call: {
          id: 't1',
          title: 'read',
          kind: 'read',
          input_preview: '{"path":"a.txt"}',
        },
      }),
      event(5, {
        kind: 'tool_call_update',
        update: { id: 't1', status: 'in_progress', content: 'partial' },
      }),
    ];

    const { turns, inProgressToolCallIds } = buildStreamingTurns(envelopes, 'c');

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ id: 'live-c-p1', role: 'assistant' });
    expect(turns[0].blocks).toEqual([
      { type: 'text', text: 'Hello world' },
      {
        type: 'tool_use',
        tool_use_id: 't1',
        tool_name: 'read',
        input_preview: '{"path":"a.txt"}',
        meta: null,
      },
      { type: 'tool_result', tool_use_id: 't1', output_preview: 'partial', is_error: false, agent_stats: null },
    ]);
    expect(inProgressToolCallIds.has('t1')).toBe(true);
  });

  it('clears in-progress on a final tool status and updates the result in place', () => {
    const envelopes: AgentEventEnvelope[] = [
      promptStarted(1, 'p1'),
      event(2, { kind: 'tool_call', tool_call: { id: 't1', title: 'read', kind: null } }),
      event(3, { kind: 'tool_call_update', update: { id: 't1', status: 'in_progress', content: 'partial' } }),
      event(4, { kind: 'tool_call_update', update: { id: 't1', status: 'completed', content: 'done' } }),
    ];

    const { turns, inProgressToolCallIds } = buildStreamingTurns(envelopes, 'c');

    expect(inProgressToolCallIds.size).toBe(0);
    const results = turns[0].blocks.filter((block) => block.type === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ output_preview: 'done', is_error: false });
  });

  it('returns no streaming turn once the prompt has finished', () => {
    const envelopes: AgentEventEnvelope[] = [
      promptStarted(1, 'p1'),
      event(2, { kind: 'message_chunk', content: { kind: 'text', text: 'done' } }),
      event(3, { kind: 'prompt_finished', finished: { prompt_id: 'p1', stop_reason: 'end_turn' } }),
    ];

    expect(buildStreamingTurns(envelopes, 'c').turns).toEqual([]);
  });
});

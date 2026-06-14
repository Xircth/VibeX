import { describe, expect, it } from 'vitest';
import type { ContentBlock, MessageTurn, TurnRole } from 'shared/types';
import type { AgentEventEnvelope } from './types';
import { buildTurnsFromEvents, getTimelineTurns } from './timeline';

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

function promptStarted(seq: number, id: string, text = 'hi'): AgentEventEnvelope {
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

function turn(
  id: string,
  role: TurnRole,
  blocks: ContentBlock[] = [],
  completedAt: string | null = null
): MessageTurn {
  return {
    id,
    role,
    blocks,
    timestamp: '2026-06-11T00:00:00.000Z',
    completed_at: completedAt,
  };
}

describe('buildTurnsFromEvents', () => {
  it('reconstructs user and assistant turns from the event stream', () => {
    const { turns } = buildTurnsFromEvents(
      [
        promptStarted(1, 'p1', 'Inspect repo'),
        event(2, {
          kind: 'message_chunk',
          content: { kind: 'text', text: 'Looking ' },
        }),
        event(3, {
          kind: 'message_chunk',
          content: { kind: 'text', text: 'now' },
        }),
        event(4, {
          kind: 'prompt_finished',
          finished: { prompt_id: 'p1', stop_reason: 'end_turn' },
        }),
      ],
      'c'
    );

    expect(turns.map((candidate) => [candidate.role, candidate.id])).toEqual([
      ['user', 'u-c-p1'],
      ['assistant', 'a-c-p1'],
    ]);
    expect(turns[0].blocks).toEqual([{ type: 'text', text: 'Inspect repo' }]);
    expect(turns[1].blocks).toEqual([{ type: 'text', text: 'Looking now' }]);
    expect(turns[1].completed_at).not.toBeNull();
  });

  it('keeps an unfinished assistant turn open with in-progress tools', () => {
    const { turns, inProgressToolCallIds } = buildTurnsFromEvents(
      [
        promptStarted(1, 'p1'),
        event(2, {
          kind: 'tool_call',
          tool_call: {
            id: 't1',
            title: 'read',
            kind: 'read',
            input_preview: '{"path":"a.txt"}',
          },
        }),
        event(3, {
          kind: 'tool_call_update',
          update: { id: 't1', status: 'in_progress', content: 'partial' },
        }),
      ],
      'c'
    );

    expect(turns).toHaveLength(2);
    expect(turns[1].completed_at).toBeNull();
    expect(turns[1].blocks).toEqual([
      {
        type: 'tool_use',
        tool_use_id: 't1',
        tool_name: 'read',
        input_preview: '{"path":"a.txt"}',
        meta: null,
      },
      {
        type: 'tool_result',
        tool_use_id: 't1',
        output_preview: 'partial',
        is_error: false,
        agent_stats: null,
      },
    ]);
    expect(inProgressToolCallIds.has('t1')).toBe(true);
  });

  it('reconstructs multiple rounds in order', () => {
    const { turns } = buildTurnsFromEvents(
      [
        promptStarted(1, 'p1', 'one'),
        event(2, {
          kind: 'message_chunk',
          content: { kind: 'text', text: 'first' },
        }),
        event(3, { kind: 'prompt_finished', finished: { prompt_id: 'p1' } }),
        promptStarted(4, 'p2', 'two'),
        event(5, {
          kind: 'message_chunk',
          content: { kind: 'text', text: 'second' },
        }),
      ],
      'c'
    );

    expect(turns.map((candidate) => candidate.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(turns[3].completed_at).toBeNull();
  });
});

describe('getTimelineTurns', () => {
  it('renders persisted turns when there are no live events', () => {
    const timeline = getTimelineTurns({
      conversationId: 'c',
      persisted: [turn('u1', 'user'), turn('a1', 'assistant')],
      live: [],
    });

    expect(timeline.map((entry) => [entry.turn.id, entry.phase])).toEqual([
      ['u1', 'persisted'],
      ['a1', 'persisted'],
    ]);
  });

  it('uses live turns and marks the in-flight assistant as streaming', () => {
    const timeline = getTimelineTurns({
      conversationId: 'c',
      persisted: [],
      live: [turn('u-c-p1', 'user'), turn('a-c-p1', 'assistant', [], null)],
      inProgressToolCallIds: new Set(['t1']),
    });

    expect(timeline.map((entry) => entry.phase)).toEqual([
      'persisted',
      'streaming',
    ]);
    expect(timeline[1].inProgressToolCallIds?.has('t1')).toBe(true);
  });

  it('prepends persisted history that precedes the live conversation', () => {
    const old = {
      ...turn('old', 'assistant'),
      timestamp: '2026-06-10T00:00:00.000Z',
    };
    const liveUser = {
      ...turn('u-c-p1', 'user'),
      timestamp: '2026-06-11T00:00:01.000Z',
    };
    const timeline = getTimelineTurns({
      conversationId: 'c',
      persisted: [old],
      live: [liveUser],
    });

    expect(timeline.map((entry) => entry.turn.id)).toEqual(['old', 'u-c-p1']);
  });
});

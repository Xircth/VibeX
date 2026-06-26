import { describe, expect, it } from 'vitest';
import type {
  ConversationEventEnvelope,
  DbConversationDetail,
} from 'shared/types';
import {
  conversationStoreReducer,
  emptyConversationStoreState,
  sideRowsForEntry,
  timelineTurnsForEntry,
} from './conversationStore';

function envelope(
  sequence: bigint,
  event: ConversationEventEnvelope['event'],
  turnId = 'turn-1'
): ConversationEventEnvelope {
  return {
    id: `event-${sequence}`,
    conversation_id: 'conversation-1',
    turn_id: turnId,
    sequence,
    source: 'test',
    event,
    created_at: '2026-06-14T00:00:00.000Z',
  };
}

function emptyDetail(): DbConversationDetail {
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

describe('conversationStoreReducer', () => {
  it('hydrates detail and applies ordered realtime events', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(1n, {
        kind: 'user_turn_created',
        blocks: [{ kind: 'text', text: 'hello' }],
      }),
    });
    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(2n, {
        kind: 'assistant_text_delta',
        text: 'hi',
        message_id: null,
      }),
    });

    const entry = state.byConversationId['conversation-1'];
    expect(entry.lastSequence).toBe(2n);
    expect(timelineTurnsForEntry(entry).map((row) => row.turn.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('shows a pending assistant turn while the agent is thinking', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(1n, {
        kind: 'user_turn_created',
        blocks: [{ kind: 'text', text: 'think about this' }],
      }),
    });

    const turns = timelineTurnsForEntry(
      state.byConversationId['conversation-1']
    );
    expect(turns.map((row) => row.turn.role)).toEqual(['user', 'assistant']);
    expect(turns[1]).toMatchObject({
      phase: 'streaming',
      turn: {
        id: 'turn-1:assistant',
        role: 'assistant',
        blocks: [],
      },
    });
  });

  it('shows a pending assistant turn immediately after an optimistic user turn', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: 'conversation-1',
      turn: {
        id: 'optimistic-turn',
        role: 'user',
        blocks: [{ type: 'text', text: 'start now' }],
        timestamp: '2026-06-14T00:00:00.000Z',
      },
    });

    const turns = timelineTurnsForEntry(
      state.byConversationId['conversation-1']
    );
    expect(turns.map((row) => [row.turn.role, row.phase])).toEqual([
      ['user', 'optimistic'],
      ['assistant', 'streaming'],
    ]);
    expect(turns[1].turn).toMatchObject({
      id: 'optimistic-turn:assistant',
      blocks: [],
    });
  });

  it('shows optimistic pending assistant after a previous turn has settled', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(1n, {
        kind: 'user_turn_created',
        blocks: [{ kind: 'text', text: 'first' }],
      }),
    });
    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(2n, {
        kind: 'turn_completed',
        stop_reason: null,
      }),
    });
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: 'conversation-1',
      turn: {
        id: 'optimistic-second',
        role: 'user',
        blocks: [{ type: 'text', text: 'second' }],
        timestamp: '2026-06-14T00:00:01.000Z',
      },
    });

    const turns = timelineTurnsForEntry(
      state.byConversationId['conversation-1']
    );
    expect(turns.map((row) => [row.turn.id, row.turn.role, row.phase])).toEqual(
      [
        ['turn-1:user', 'user', 'settled'],
        ['optimistic-second', 'user', 'optimistic'],
        ['optimistic-second:assistant', 'assistant', 'streaming'],
      ]
    );
  });

  it('replaces the pending assistant turn when assistant content arrives', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(1n, {
        kind: 'user_turn_created',
        blocks: [{ kind: 'text', text: 'hello' }],
      }),
    });
    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(2n, {
        kind: 'assistant_text_delta',
        text: 'hi',
        message_id: null,
      }),
    });

    const assistantTurns = timelineTurnsForEntry(
      state.byConversationId['conversation-1']
    ).filter((row) => row.turn.role === 'assistant');
    expect(assistantTurns).toHaveLength(1);
    expect(assistantTurns[0].turn.blocks).toEqual([
      { type: 'text', text: 'hi' },
    ]);
  });

  it('removes the pending assistant turn when a turn settles without content', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(1n, {
        kind: 'user_turn_created',
        blocks: [{ kind: 'text', text: 'stop early' }],
      }),
    });
    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(2n, {
        kind: 'turn_completed',
        stop_reason: null,
      }),
    });

    expect(
      timelineTurnsForEntry(state.byConversationId['conversation-1']).map(
        (row) => row.turn.role
      )
    ).toEqual(['user']);
  });

  it('detects sequence gaps before applying an event', () => {
    const state = conversationStoreReducer(
      {
        byConversationId: {
          'conversation-1': {
            conversationId: 'conversation-1',
            detail: null,
            rows: [],
            lastSequence: 3n,
            projectionVersion: 1,
            currentTurnId: null,
            loading: false,
            error: null,
            gap: { kind: 'none' },
            optimisticTurns: [],
            sessionModes: { current: null, modes: [] },
            sessionConfigOptions: [],
          },
        },
      },
      {
        type: 'event',
        envelope: envelope(5n, {
          kind: 'assistant_text_delta',
          text: 'late',
          message_id: null,
        }),
      }
    );

    expect(state.byConversationId['conversation-1'].gap).toEqual({
      kind: 'gap',
      expectedSequence: 4n,
      receivedSequence: 5n,
    });
  });

  it('does not let a stale detail response erase newer realtime turns', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });
    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(1n, {
        kind: 'user_turn_created',
        blocks: [{ kind: 'text', text: 'visible message' }],
      }),
    });

    state = conversationStoreReducer(state, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    const entry = state.byConversationId['conversation-1'];
    expect(entry.lastSequence).toBe(1n);
    expect(timelineTurnsForEntry(entry).map((row) => row.turn.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('applies canonical realtime side rows for interaction and delegation events', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    const events: ConversationEventEnvelope['event'][] = [
      {
        kind: 'question_requested',
        request: {
          question_id: 'question-1',
          prompt: 'Pick one',
          options: ['A', 'B'],
        },
      },
      {
        kind: 'feedback_requested',
        request: {
          feedback_id: 'feedback-1',
          prompt: 'Was this useful?',
        },
      },
      {
        kind: 'delegation_started',
        delegation: {
          delegation_id: 'delegation-1',
          parent_tool_call_id: 'tool-1',
          child_conversation_id: 'conversation-child',
          agent_type: 'codex',
          task_preview: 'Review the diff',
        },
      },
      {
        kind: 'session_config_stale',
        stale: true,
        reason: 'settings changed',
      },
      {
        kind: 'raw_diagnostic_recorded',
        label: 'stream recovered',
      },
    ];

    events.forEach((event, index) => {
      state = conversationStoreReducer(state, {
        type: 'event',
        envelope: envelope(BigInt(index + 1), event),
      });
    });

    expect(
      sideRowsForEntry(state.byConversationId['conversation-1']).map(
        (row) => row.kind
      )
    ).toEqual([
      'question_request',
      'feedback_request',
      'delegation',
      'session_notice',
    ]);
  });

  it('folds a delegation completion onto its running row as one card', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(1n, {
        kind: 'delegation_started',
        delegation: {
          delegation_id: 'delegation-1',
          parent_tool_call_id: 'tool-1',
          child_conversation_id: 'child-1',
          agent_type: 'codex',
          task_preview: 'Review the diff',
        },
      }),
    });
    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(2n, {
        kind: 'delegation_completed',
        delegation_id: 'delegation-1',
        result: { kind: 'ok', text_preview: 'done', duration_ms: 10n },
      }),
    });

    const sideRows = sideRowsForEntry(state.byConversationId['conversation-1']);
    const delegations = sideRows.filter((row) => row.kind === 'delegation');
    expect(delegations).toHaveLength(1);
    const row = delegations[0];
    if (row.kind !== 'delegation') throw new Error('expected delegation row');
    // The merged card keeps the start-event context AND the outcome.
    expect(row.delegation.status).toBe('completed');
    expect(row.delegation.task_preview).toBe('Review the diff');
    expect(row.delegation.child_conversation_id).toBe('child-1');
    expect(row.delegation.result).toEqual({
      kind: 'ok',
      text_preview: 'done',
      duration_ms: 10n,
    });
  });

  it('marks a delegation as failed when it completes with an error', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(1n, {
        kind: 'delegation_started',
        delegation: {
          delegation_id: 'delegation-1',
          parent_tool_call_id: 'tool-1',
          child_conversation_id: 'child-1',
          agent_type: 'codex',
          task_preview: 'Review the diff',
        },
      }),
    });
    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(2n, {
        kind: 'delegation_completed',
        delegation_id: 'delegation-1',
        result: { kind: 'err', error: { message: 'boom' } },
      }),
    });

    const sideRows = sideRowsForEntry(state.byConversationId['conversation-1']);
    const delegations = sideRows.filter((row) => row.kind === 'delegation');
    expect(delegations).toHaveLength(1);
    const row = delegations[0];
    if (row.kind !== 'delegation') throw new Error('expected delegation row');
    expect(row.delegation.status).toBe('failed');
  });

  it('tracks agent-advertised session modes and config options on the entry', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(1n, {
        kind: 'session_mode_updated',
        current: 'plan',
        modes: [
          { id: 'plan', label: 'Plan' },
          { id: 'code', label: 'Code' },
        ],
      }),
    });
    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(2n, {
        kind: 'session_config_options_updated',
        options: [{ key: 'reasoning', label: 'Reasoning' }],
      }),
    });

    const entry = state.byConversationId['conversation-1'];
    expect(entry.sessionModes.current).toBe('plan');
    expect(entry.sessionModes.modes.map((mode) => mode.id)).toEqual([
      'plan',
      'code',
    ]);
    expect(entry.sessionConfigOptions.map((option) => option.key)).toEqual([
      'reasoning',
    ]);
  });

  it('keeps advertised session modes across a detail reload', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });
    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(1n, {
        kind: 'session_mode_updated',
        current: 'code',
        modes: [{ id: 'code', label: 'Code' }],
      }),
    });

    // A stale detail refresh must not wipe the live-advertised modes.
    state = conversationStoreReducer(state, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    expect(
      state.byConversationId['conversation-1'].sessionModes.current
    ).toBe('code');
  });

  it('renders a code-aware notice for an expired agent session', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(1n, {
        kind: 'agent_binding_load_failed',
        reason: { kind: 'resource_not_found' },
      }),
    });

    const sideRows = sideRowsForEntry(state.byConversationId['conversation-1']);
    const notice = sideRows.find((row) => row.kind === 'session_notice');
    expect(notice).toBeDefined();
    if (notice?.kind !== 'session_notice') throw new Error('expected notice');
    expect(notice.notice.title).toBe('代理会话已过期');
    expect(notice.notice.severity).toBe('warning');
  });

  it('keeps the real ACP detail + options on a permission side row', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: emptyDetail(),
    });

    state = conversationStoreReducer(state, {
      type: 'event',
      envelope: envelope(1n, {
        kind: 'permission_requested',
        request: {
          permission_id: 'perm-1',
          request: {
            id: 'perm-1',
            session_id: 'session-1',
            title: 'Edit README.md',
            details: {
              fields: {
                kind: 'edit',
                content: [
                  {
                    type: 'diff',
                    path: 'README.md',
                    oldText: 'old',
                    newText: 'new',
                  },
                ],
              },
            },
            options: [
              { id: 'allow', label: 'Allow', kind: 'allow_once' },
              { id: 'deny', label: 'Deny', kind: 'reject_once' },
            ],
          },
        },
      }),
    });

    const sideRows = sideRowsForEntry(state.byConversationId['conversation-1']);
    expect(sideRows).toHaveLength(1);
    const row = sideRows[0];
    expect(row.kind).toBe('permission_request');
    if (row.kind !== 'permission_request') throw new Error('expected permission row');
    expect(row.request.status).toBe('pending');
    expect(row.request.options).toHaveLength(2);
    expect(row.request.options?.[0].id).toBe('allow');
    expect(row.request.details).toMatchObject({
      fields: { kind: 'edit' },
    });
  });

  it('keeps import-restored projected timeline rows from detail', () => {
    const importedDetail = emptyDetail();
    importedDetail.timeline = {
      conversation_id: 'conversation-1',
      projection_version: 1,
      last_sequence: 7n,
      rows: [
        {
          kind: 'message_turn',
          phase: 'settled',
          turn: {
            id: 'turn-1:assistant',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'restored reply' }],
            timestamp: '2026-06-14T00:00:00.000Z',
          },
        },
        {
          kind: 'session_notice',
          notice: {
            title: 'Agent session load failed',
            message: 'restored from import',
            severity: 'warning',
          },
        },
      ],
    };

    const state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: importedDetail,
    });

    const entry = state.byConversationId['conversation-1'];
    expect(entry.lastSequence).toBe(7n);
    expect(timelineTurnsForEntry(entry)[0].turn.blocks).toEqual([
      { type: 'text', text: 'restored reply' },
    ]);
    expect(sideRowsForEntry(entry)[0].kind).toBe('session_notice');
  });
});

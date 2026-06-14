import { describe, expect, it } from 'vitest';
import type { ConversationEventEnvelope, DbConversationDetail } from 'shared/types';
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
      'session_notice',
    ]);
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

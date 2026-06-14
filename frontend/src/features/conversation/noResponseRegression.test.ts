import { describe, expect, it } from 'vitest';
import type { ConversationEventEnvelope, DbConversationDetail } from 'shared/types';
import {
  conversationStoreReducer,
  emptyConversationStoreState,
  sideRowsForEntry,
} from './conversationStore';

function detail(): DbConversationDetail {
  return {
    summary: {
      id: 'conversation-1',
      workspace_id: 'workspace-1',
      task_id: null,
      title: 'No response regression',
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

function envelope(
  sequence: bigint,
  event: ConversationEventEnvelope['event']
): ConversationEventEnvelope {
  return {
    id: `event-${sequence}`,
    conversation_id: 'conversation-1',
    turn_id: 'turn-1',
    sequence,
    source: 'runtime',
    event,
    created_at: '2026-06-14T00:00:00.000Z',
  };
}

describe('no-response conversation regressions', () => {
  it.each([
    'agent connection command channel closed',
    'handshake timed out',
    'agent process exited before producing output',
    'session/prompt failed',
  ])('renders a visible failed turn for %s', (message) => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: 'conversation-1',
      detail: detail(),
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
        kind: 'turn_failed',
        error: { message, code: 'no_response' },
      }),
    });

    const sideRows = sideRowsForEntry(state.byConversationId['conversation-1']);
    expect(sideRows).toContainEqual({
      kind: 'turn_error',
      error: {
        turn_id: 'turn-1',
        error: { message, code: 'no_response' },
      },
    });
  });
});

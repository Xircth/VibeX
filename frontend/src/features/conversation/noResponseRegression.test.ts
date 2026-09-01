import { describe, expect, it } from 'vitest';
import type {
  ConversationRowOpBatch,
  DbConversationDetail,
  TimelineRow,
} from 'shared/types';
import {
  conversationStoreReducer,
  emptyConversationStoreState,
  sideRowsForEntry,
} from './conversationStore';

const CONVERSATION_ID = 'conversation-1';

function detail(): DbConversationDetail {
  return {
    summary: {
      id: CONVERSATION_ID,
      workspace_id: 'workspace-1',
      task_id: null,
      title: 'No response regression',
      title_locked: false,
      status: 'inprogress',
      agent_id: 'codex' as const,
      model: null,
      external_session_id: null,
      message_count: 0n,
      pinned_at: null,
      parent_session_id: null,
      parent_tool_use_id: null,
      delegation_call_id: null,
      created_at: '2026-07-03T00:00:00.000Z',
      updated_at: '2026-07-03T00:00:00.000Z',
    },
    turns: [],
    timeline: {
      conversation_id: CONVERSATION_ID,
      projection_version: 2,
      last_sequence: 0n,
      rows: [],
      truncated_from_start: false,
    },
    projection_version: 2,
    session_config_options: [],
  };
}

function batch(
  rows: TimelineRow[],
  lastSequence: bigint
): ConversationRowOpBatch {
  return {
    conversation_id: CONVERSATION_ID,
    last_sequence: lastSequence,
    ops: rows.map((row) => ({ op: 'upsert', row })),
    session_modes: null,
    session_config_options: null,
  };
}

describe('no-response conversation regressions', () => {
  it.each([
    'agent connection command channel closed',
    'handshake timed out',
    'agent process exited before producing output',
    'session/prompt failed',
  ])('renders a visible failed turn for %s', (message) => {
    // The backend projector emits the failed turn as a `turn_error` row-op upsert;
    // the frontend just surfaces it (消灭双投影 — no client-side folding).
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: detail(),
    });
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            row_id: 'err:turn-1:2',
            revision: 2n,
            row: {
              kind: 'turn_error',
              error: {
                turn_id: 'turn-1',
                error: { message, code: 'no_response' },
              },
            },
          },
        ],
        2n
      ),
    });

    const sideRows = sideRowsForEntry(state.byConversationId[CONVERSATION_ID]);
    expect(
      sideRows.map((row) => row.row).filter((row) => row.kind === 'turn_error')
    ).toContainEqual({
      kind: 'turn_error',
      error: {
        turn_id: 'turn-1',
        error: { message, code: 'no_response' },
      },
    });
  });
});

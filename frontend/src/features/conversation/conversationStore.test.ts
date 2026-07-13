import { describe, expect, it } from 'vitest';
import type {
  ContentBlock,
  ConversationRowOp,
  ConversationRowOpBatch,
  ConversationTimelineRow,
  DbConversationDetail,
  MessageTurn,
  TimelineRow,
} from 'shared/types';
import {
  conversationStoreReducer,
  emptyConversationStoreState,
  sideRowsForEntry,
  timelineTurnsForEntry,
  type ConversationStoreState,
} from './conversationStore';

const CONVERSATION_ID = 'conversation-1';

function batch(
  ops: ConversationRowOp[],
  lastSequence: bigint,
  extra: Partial<ConversationRowOpBatch> = {}
): ConversationRowOpBatch {
  return {
    conversation_id: CONVERSATION_ID,
    last_sequence: lastSequence,
    ops,
    session_modes: null,
    session_config_options: null,
    ...extra,
  };
}

function timelineRow(
  rowId: string,
  revision: bigint,
  row: ConversationTimelineRow
): TimelineRow {
  return { row_id: rowId, revision, row };
}

function userRow(turnId: string, text: string, revision: bigint): TimelineRow {
  return timelineRow(`${turnId}:user`, revision, {
    kind: 'message_turn',
    phase: 'persisted',
    turn: messageTurn(`${turnId}:user`, 'user', [{ type: 'text', text }]),
  });
}

function assistantRow(
  turnId: string,
  blocks: ContentBlock[],
  revision: bigint,
  phase = 'settled'
): TimelineRow {
  return timelineRow(`${turnId}:assistant`, revision, {
    kind: 'message_turn',
    phase,
    turn: messageTurn(`${turnId}:assistant`, 'assistant', blocks),
  });
}

function messageTurn(
  id: string,
  role: 'user' | 'assistant',
  blocks: ContentBlock[]
): MessageTurn {
  return {
    id,
    role,
    blocks,
    timestamp: '2026-07-03T00:00:00.000Z',
  };
}

function emptyDetail(rows: TimelineRow[] = []): DbConversationDetail {
  return {
    summary: {
      id: CONVERSATION_ID,
      workspace_id: 'workspace-1',
      task_id: null,
      title: 'Conversation',
      title_locked: false,
      status: 'inprogress',
      agent_type: 'codex' as const,
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
      last_sequence: rows.length ? 1n : 0n,
      rows,
    },
    projection_version: 2,
    session_config_options: [],
  };
}

function loaded(rows: TimelineRow[] = []): ConversationStoreState {
  return conversationStoreReducer(emptyConversationStoreState, {
    type: 'load_success',
    conversationId: CONVERSATION_ID,
    detail: emptyDetail(rows),
  });
}

function entryOf(state: ConversationStoreState) {
  return state.byConversationId[CONVERSATION_ID];
}

describe('conversationStore (row-op dumb container)', () => {
  it('hydrates rows straight from the projected detail timeline', () => {
    const state = loaded([userRow('t1', 'hello', 1n)]);
    const turns = timelineTurnsForEntry(entryOf(state));
    expect(turns.map((row) => [row.turn.role, row.phase])).toEqual([
      ['user', 'persisted'],
    ]);
  });

  it('upserts a user message-turn row from a row-op batch', () => {
    let state = loaded();
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch([{ op: 'upsert', row: userRow('t1', 'do it', 1n) }], 1n),
    });
    const turns = timelineTurnsForEntry(entryOf(state));
    expect(turns.some((row) => row.turn.id === 't1:user')).toBe(true);
    expect(entryOf(state).lastSequence).toBe(1n);
  });

  it('accumulates streaming text in a live overlay and renders it', () => {
    let state = loaded([userRow('t1', 'q', 1n)]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'append_text',
            row_id: 't1:assistant',
            revision: 2n,
            stream: 'text',
            delta: 'hel',
          },
        ],
        2n
      ),
    });
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'append_text',
            row_id: 't1:assistant',
            revision: 3n,
            stream: 'text',
            delta: 'lo',
          },
        ],
        3n
      ),
    });
    const turns = timelineTurnsForEntry(entryOf(state));
    // A pending assistant bubble renders the accumulated live text.
    const assistant = turns.find((row) => row.turn.role === 'assistant');
    expect(assistant?.phase).toBe('streaming');
    expect(textOf(assistant?.turn.blocks ?? [])).toBe('hello');
  });

  it('flushes the live overlay when the row is upserted (no double text)', () => {
    let state = loaded([userRow('t1', 'q', 1n)]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'append_text',
            row_id: 't1:assistant',
            revision: 2n,
            stream: 'text',
            delta: 'hello',
          },
        ],
        2n
      ),
    });
    // Terminal upsert carries the full folded assistant row (text included).
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: assistantRow('t1', [{ type: 'text', text: 'hello' }], 3n),
          },
        ],
        3n
      ),
    });
    expect(entryOf(state).liveText['t1:assistant']).toBeUndefined();
    const assistant = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    expect(textOf(assistant?.turn.blocks ?? [])).toBe('hello');
    expect(assistant?.phase).toBe('settled');
  });

  it('is idempotent: a re-delivered append is not applied twice', () => {
    let state = loaded([userRow('t1', 'q', 1n)]);
    const append: ConversationRowOp = {
      op: 'append_text',
      row_id: 't1:assistant',
      revision: 2n,
      stream: 'text',
      delta: 'x',
    };
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch([append], 2n),
    });
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch([append], 2n),
    });
    expect(entryOf(state).liveText['t1:assistant'].text).toBe('x');
  });

  it('ignores an upsert whose revision is stale', () => {
    let state = loaded([assistantRow('t1', [{ type: 'text', text: 'new' }], 5n)]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: assistantRow('t1', [{ type: 'text', text: 'old' }], 3n),
          },
        ],
        6n
      ),
    });
    const assistant = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    expect(textOf(assistant?.turn.blocks ?? [])).toBe('new');
  });

  it('keeps the live overlay when a re-delivered upsert is behind the streamed text', () => {
    // 丢字 regression: an assistant row upserted at rev 2, then streamed deltas grow the
    // overlay to rev 5. A late/duplicate upsert at rev 2 (== existing) is applied but must
    // NOT wipe the newer overlay text, or "llo" would vanish until the next real event.
    let state = loaded([userRow('t1', 'q', 1n)]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [{ op: 'upsert', row: assistantRow('t1', [{ type: 'text', text: 'he' }], 2n, 'streaming') }],
        2n
      ),
    });
    for (const [revision, delta] of [
      [3n, 'l'],
      [4n, 'l'],
      [5n, 'o'],
    ] as const) {
      state = conversationStoreReducer(state, {
        type: 'row_ops',
        batch: batch(
          [{ op: 'append_text', row_id: 't1:assistant', revision, stream: 'text', delta }],
          revision
        ),
      });
    }
    // Re-delivered older upsert (rev 2 == current row rev) — applied, but behind the overlay.
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [{ op: 'upsert', row: assistantRow('t1', [{ type: 'text', text: 'he' }], 2n, 'streaming') }],
        2n
      ),
    });
    expect(entryOf(state).liveText['t1:assistant']?.text).toBe('llo');
    const assistant = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    expect(textOf(assistant?.turn.blocks ?? [])).toBe('hello');
  });

  it('renders an interrupted turn terminal without a phantom stream', () => {
    // ADR-0001: interrupted user row is terminal → no pending assistant bubble.
    const state = loaded([
      timelineRow('t1:user', 1n, {
        kind: 'message_turn',
        phase: 'interrupted',
        turn: messageTurn('t1:user', 'user', [{ type: 'text', text: 'q' }]),
      }),
    ]);
    const turns = timelineTurnsForEntry(entryOf(state));
    expect(turns.map((row) => [row.turn.role, row.phase])).toEqual([
      ['user', 'interrupted'],
    ]);
  });

  it('applies agent-advertised session modes carried by a batch', () => {
    let state = loaded();
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch([], 1n, {
        session_modes: { current: 'plan', modes: [] },
      }),
    });
    expect(entryOf(state).sessionModes.current).toBe('plan');
  });

  it('exposes side rows (with row_id) via sideRowsForEntry', () => {
    let state = loaded();
    const permission: TimelineRow = timelineRow('perm:p1', 2n, {
      kind: 'permission_request',
      request: {
        permission_id: 'p1',
        title: 'Allow?',
        status: 'pending',
        details: null,
        options: [],
      },
    });
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch([{ op: 'upsert', row: permission }], 2n),
    });
    const sideRows = sideRowsForEntry(entryOf(state));
    expect(sideRows.map((row) => [row.row_id, row.row.kind])).toEqual([
      ['perm:p1', 'permission_request'],
    ]);
  });

  it('shows a pending assistant bubble after an optimistic user turn', () => {
    let state = loaded();
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn('optimistic-1', 'user', [
        { type: 'text', text: 'go' },
      ]),
    });
    const turns = timelineTurnsForEntry(entryOf(state));
    expect(turns.map((row) => [row.turn.role, row.phase])).toEqual([
      ['user', 'optimistic'],
      ['assistant', 'streaming'],
    ]);
  });

  it('keeps rows straight from an imported/reloaded detail timeline', () => {
    const state = loaded([
      userRow('t1', 'hi', 1n),
      assistantRow('t1', [{ type: 'text', text: 'hello' }], 1n),
    ]);
    const turns = timelineTurnsForEntry(entryOf(state));
    expect(turns.map((row) => row.turn.role)).toEqual(['user', 'assistant']);
  });
});

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
}

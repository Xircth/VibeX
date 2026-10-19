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
import { formatSessionComposerCommand } from '@/components/tasks/follow-up/sessionComposerStructuredTokens';
import {
  conversationStoreReducer,
  emptyConversationStoreState,
  sideRowsForEntry,
  timelineItemsForEntry,
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

function streamingUser(
  turnId: string,
  text: string,
  revision: bigint
): TimelineRow {
  return timelineRow(`${turnId}:user`, revision, {
    kind: 'message_turn',
    phase: 'streaming',
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
      last_sequence: rows.length ? 1n : 0n,
      rows,
      truncated_from_start: false,
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
    expect(entryOf(state).detail?.timeline.rows).toEqual([]);
  });

  it('hydrates session-config summary fields from conversation detail', () => {
    const state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: {
        ...emptyDetail(),
        session_modes: {
          current: 'plan',
          modes: [{ id: 'plan', label: 'Plan' }],
        },
        session_config_options: [
          {
            key: 'model',
            label: 'Model',
            category: 'model',
            value: 'grok-4',
            choices: [{ value: 'grok-4', label: 'Grok 4' }],
          },
        ],
      },
    });
    expect(entryOf(state).sessionModes).toEqual({
      current: 'plan',
      modes: [{ id: 'plan', label: 'Plan' }],
    });
    expect(entryOf(state).sessionConfigOptions).toEqual([
      expect.objectContaining({ key: 'model', value: 'grok-4' }),
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
    let state = loaded([
      assistantRow('t1', [{ type: 'text', text: 'new' }], 5n),
    ]);
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
        [
          {
            op: 'upsert',
            row: assistantRow(
              't1',
              [{ type: 'text', text: 'he' }],
              2n,
              'streaming'
            ),
          },
        ],
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
          [
            {
              op: 'append_text',
              row_id: 't1:assistant',
              revision,
              stream: 'text',
              delta,
            },
          ],
          revision
        ),
      });
    }
    // Re-delivered older upsert (rev 2 == current row rev) — applied, but behind the overlay.
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: assistantRow(
              't1',
              [{ type: 'text', text: 'he' }],
              2n,
              'streaming'
            ),
          },
        ],
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

  it('stops streaming an assistant row once the paired user turn is terminal', () => {
    for (const phase of ['failed', 'cancelled', 'interrupted'] as const) {
      const state = loaded([
        timelineRow('t1:user', 2n, {
          kind: 'message_turn',
          phase,
          turn: messageTurn('t1:user', 'user', [{ type: 'text', text: 'q' }]),
        }),
        assistantRow(
          't1',
          [{ type: 'text', text: 'partial' }],
          1n,
          'streaming'
        ),
      ]);
      const assistant = timelineTurnsForEntry(entryOf(state)).find(
        (row) => row.turn.role === 'assistant'
      );
      expect(assistant?.phase).toBe(phase);
    }
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

  it('keeps the live available-commands catalog instead of guessing an empty set', () => {
    let state = loaded();
    expect(entryOf(state).availableCommands).toBeNull();
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch([], 1n, {
        available_commands: [
          { name: 'compact', description: 'Compact context' },
        ],
      }),
    });
    expect(entryOf(state).availableCommands).toEqual([
      { name: 'compact', description: 'Compact context' },
    ]);
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

  it('removes a resolved session notice from a realtime row-op batch', () => {
    const notice = timelineRow('notice:agent-binding-load-failed', 1n, {
      kind: 'session_notice',
      notice: {
        title: '加载代理会话失败',
        message: 'session/load failed: no rollout found',
        severity: 'warning',
      },
    });
    let state = loaded([notice]);

    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'delete',
            row_id: notice.row_id,
            revision: 2n,
          },
        ],
        2n
      ),
    });

    expect(sideRowsForEntry(entryOf(state))).toEqual([]);
  });

  it('shows a pending assistant bubble after an optimistic user turn', () => {
    let state = loaded();
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn('optimistic-1', 'user', [{ type: 'text', text: 'go' }]),
    });
    const turns = timelineTurnsForEntry(entryOf(state));
    expect(turns.map((row) => [row.turn.role, row.phase])).toEqual([
      ['user', 'optimistic'],
      ['assistant', 'streaming'],
    ]);
  });

  it('keeps the same-turn user before an assistant row that arrived first', () => {
    let state = loaded();
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn('optimistic-1', 'user', [{ type: 'text', text: 'go' }]),
    });
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: assistantRow(
              't1',
              [{ type: 'text', text: 'hello' }],
              2n,
              'streaming'
            ),
          },
        ],
        2n
      ),
    });

    expect(
      timelineTurnsForEntry(entryOf(state)).map((row) => row.turn.role)
    ).toEqual(['user', 'assistant']);

    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch([{ op: 'upsert', row: userRow('t1', 'go', 3n) }], 3n),
    });

    expect(
      timelineTurnsForEntry(entryOf(state)).map((row) => [
        row.turn.role,
        row.turn.id,
      ])
    ).toEqual([
      ['user', 't1:user'],
      ['assistant', 't1:assistant'],
    ]);
  });

  it('replays a snapshot whose assistant row was stored ahead of its user', () => {
    const state = loaded([
      assistantRow('t1', [{ type: 'text', text: 'hello' }], 2n),
      userRow('t1', 'go', 1n),
    ]);
    expect(
      timelineTurnsForEntry(entryOf(state)).map((row) => [
        row.turn.role,
        row.turn.id,
      ])
    ).toEqual([
      ['user', 't1:user'],
      ['assistant', 't1:assistant'],
    ]);
  });

  it('keeps the pending assistant bubble while the sent user turn is confirmed', () => {
    let state = loaded();
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn('optimistic-1', 'user', [{ type: 'text', text: 'go' }]),
    });
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: timelineRow('turn-1:user', 1n, {
              kind: 'message_turn',
              phase: 'streaming',
              turn: messageTurn('turn-1:user', 'user', [
                { type: 'text', text: 'go' },
              ]),
            }),
          },
        ],
        1n
      ),
    });

    const turns = timelineTurnsForEntry(entryOf(state));
    expect(turns.map((row) => [row.turn.role, row.phase])).toEqual([
      ['user', 'streaming'],
      ['assistant', 'streaming'],
    ]);
  });

  it('reconciles a normalized server user row with the richer optimistic token text', () => {
    const tokenizedDisplay = `${formatSessionComposerCommand({
      type: '/',
      key: 'skill:/Users/mac/.agents/skills/grilling:grill-me',
      value: '/grill-me',
    })} critique this`;
    let state = loaded();
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn('optimistic-1', 'user', [
        { type: 'text', text: tokenizedDisplay },
      ]),
    });
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: timelineRow('turn-1:user', 1n, {
              kind: 'message_turn',
              phase: 'streaming',
              turn: messageTurn('turn-1:user', 'user', [
                { type: 'text', text: '/grill-me critique this' },
              ]),
            }),
          },
        ],
        1n
      ),
    });

    const userTurns = timelineTurnsForEntry(entryOf(state)).filter(
      (row) => row.turn.role === 'user'
    );
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]?.turn.blocks).toEqual([
      { type: 'text', text: tokenizedDisplay },
    ]);
  });

  it('reconciles a persisted normalized user row with its optimistic token turn', () => {
    const tokenizedDisplay = `${formatSessionComposerCommand({
      type: '/',
      key: 'skill:/Users/mac/.codex/skills/drawio/drawio:drawio',
      value: '/drawio',
    })} draw the architecture`;
    let state = loaded();
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn('optimistic-1', 'user', [
        { type: 'text', text: tokenizedDisplay },
      ]),
    });
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: timelineRow('turn-1:user', 1n, {
              kind: 'message_turn',
              phase: 'persisted',
              turn: messageTurn('turn-1:user', 'user', [
                { type: 'text', text: '/drawio draw the architecture' },
              ]),
            }),
          },
          {
            op: 'upsert',
            row: timelineRow('turn-1:assistant', 1n, {
              kind: 'message_turn',
              phase: 'streaming',
              turn: messageTurn('turn-1:assistant', 'assistant', [
                { type: 'text', text: 'working' },
              ]),
            }),
          },
        ],
        1n
      ),
    });

    const timeline = timelineTurnsForEntry(entryOf(state));
    const userTurns = timeline.filter((row) => row.turn.role === 'user');
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]?.turn.blocks).toEqual([
      { type: 'text', text: tokenizedDisplay },
    ]);
    expect(
      timeline.filter((row) => row.turn.role === 'assistant')
    ).toHaveLength(1);
  });

  it('does not consume an unrelated optimistic turn for a streaming user row', () => {
    let state = loaded();
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn('optimistic-1', 'user', [
        { type: 'text', text: 'second request' },
      ]),
    });
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: timelineRow('turn-1:user', 1n, {
              kind: 'message_turn',
              phase: 'streaming',
              turn: messageTurn('turn-1:user', 'user', [
                { type: 'text', text: 'first request' },
              ]),
            }),
          },
        ],
        1n
      ),
    });

    expect(
      timelineTurnsForEntry(entryOf(state))
        .filter((row) => row.turn.role === 'user')
        .map((row) => row.turn.blocks)
    ).toEqual([
      [{ type: 'text', text: 'first request' }],
      [{ type: 'text', text: 'second request' }],
    ]);
  });

  it('keeps reconciled token text across later authoritative user-row upserts', () => {
    const tokenizedDisplay = `${formatSessionComposerCommand({
      type: '/',
      key: 'skill:/Users/mac/.agents/skills/research:research',
      value: '/research',
    })} compare these projects`;
    let state = loaded();
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn('optimistic-1', 'user', [
        { type: 'text', text: tokenizedDisplay },
      ]),
    });
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: timelineRow('turn-1:user', 1n, {
              kind: 'message_turn',
              phase: 'streaming',
              turn: messageTurn('turn-1:user', 'user', [
                { type: 'text', text: '/research compare these projects' },
              ]),
            }),
          },
        ],
        1n
      ),
    });

    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: timelineRow('turn-1:user', 2n, {
              kind: 'message_turn',
              phase: 'settled',
              turn: messageTurn('turn-1:user', 'user', [
                { type: 'text', text: '/research compare these projects' },
              ]),
            }),
          },
        ],
        2n
      ),
    });

    const userTurns = timelineTurnsForEntry(entryOf(state)).filter(
      (row) => row.turn.role === 'user'
    );
    expect(userTurns).toHaveLength(1);
    expect(userTurns[0]?.turn.blocks).toEqual([
      { type: 'text', text: tokenizedDisplay },
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

  it('keeps a stable conversation key across the pending-to-persisted assistant handoff', () => {
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
            delta: 'he',
          },
        ],
        2n
      ),
    });
    const pending = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    expect(pending?.key).toBe('conversation-t1:assistant');

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
    const persisted = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    expect(persisted?.key).toBe('conversation-t1:assistant');
  });

  it('appends live text after tools as a new block, not onto earlier prose', () => {
    let state = loaded([
      userRow('t1', 'q', 1n),
      assistantRow(
        't1',
        [
          { type: 'text', text: 'A' },
          {
            type: 'tool_use',
            tool_name: 'bash',
            tool_use_id: 'tool-1',
            input_preview: '{}',
            meta: null,
          },
          {
            type: 'tool_use',
            tool_name: 'Task',
            tool_use_id: 'tool-2',
            input_preview: '{}',
            meta: null,
          },
        ],
        2n,
        'streaming'
      ),
    ]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'append_text',
            row_id: 't1:assistant',
            revision: 3n,
            stream: 'text',
            delta: 'D',
          },
        ],
        3n
      ),
    });
    const assistant = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    expect(assistant?.turn.blocks).toEqual([
      { type: 'text', text: 'A' },
      {
        type: 'tool_use',
        tool_name: 'bash',
        tool_use_id: 'tool-1',
        input_preview: '{}',
        meta: null,
      },
      {
        type: 'tool_use',
        tool_name: 'Task',
        tool_use_id: 'tool-2',
        input_preview: '{}',
        meta: null,
      },
      { type: 'text', text: 'D' },
    ]);
  });

  it('appends live reasoning after tools as a new thinking block', () => {
    let state = loaded([
      userRow('t1', 'q', 1n),
      assistantRow(
        't1',
        [
          { type: 'thinking', text: 'plan' },
          {
            type: 'tool_use',
            tool_name: 'bash',
            tool_use_id: 'tool-1',
            input_preview: '{}',
            meta: null,
          },
        ],
        2n,
        'streaming'
      ),
    ]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'append_text',
            row_id: 't1:assistant',
            revision: 3n,
            stream: 'reasoning',
            delta: 'next',
          },
        ],
        3n
      ),
    });
    const assistant = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    expect(assistant?.turn.blocks).toEqual([
      { type: 'thinking', text: 'plan' },
      {
        type: 'tool_use',
        tool_name: 'bash',
        tool_use_id: 'tool-1',
        input_preview: '{}',
        meta: null,
      },
      { type: 'thinking', text: 'next' },
    ]);
  });

  it('still extends the last text block when nothing else followed it', () => {
    let state = loaded([
      userRow('t1', 'q', 1n),
      assistantRow('t1', [{ type: 'text', text: 'hel' }], 2n, 'streaming'),
    ]);
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
    const assistant = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    expect(assistant?.turn.blocks).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('does not concatenate overlay text onto a fuller upserted prefix', () => {
    let state = loaded([userRow('t1', 'q', 1n)]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'append_text',
            row_id: 't1:assistant',
            revision: 5n,
            stream: 'text',
            delta: 'he',
          },
        ],
        5n
      ),
    });
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: assistantRow(
              't1',
              [{ type: 'text', text: 'hello' }],
              3n,
              'streaming'
            ),
          },
        ],
        3n
      ),
    });
    const assistant = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    expect(textOf(assistant?.turn.blocks ?? [])).toBe('hello');
  });

  it('marks a sequence gap when live ops skip past the local cursor', () => {
    let state = loaded([userRow('t1', 'q', 1n)]);
    expect(entryOf(state).lastSequence).toBe(1n);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'append_text',
            row_id: 't1:assistant',
            revision: 6n,
            stream: 'text',
            delta: 'x',
          },
        ],
        6n
      ),
    });
    expect(entryOf(state).gap).toEqual({
      kind: 'gap',
      expectedSequence: 2n,
      receivedSequence: 6n,
    });
  });

  it('consumes only one optimistic turn when two identical prompts persist', () => {
    let state = loaded();
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn('optimistic-1', 'user', [
        { type: 'text', text: 'same' },
      ]),
    });
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn('optimistic-2', 'user', [
        { type: 'text', text: 'same' },
      ]),
    });
    state = conversationStoreReducer(state, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: emptyDetail([userRow('t1', 'same', 1n)]),
    });
    const userTurns = timelineTurnsForEntry(entryOf(state)).filter(
      (row) => row.turn.role === 'user'
    );
    expect(userTurns).toHaveLength(2);
    expect(userTurns.map((row) => row.phase)).toEqual([
      'persisted',
      'optimistic',
    ]);
  });

  it('streams an open file tail only while a turn is in flight', () => {
    const user = timelineRow('acp-1', 1n, {
      kind: 'message_turn',
      phase: 'streaming',
      turn: messageTurn('acp-1', 'user', [{ type: 'text', text: 'hi' }]),
    });
    const assistant = timelineRow('acp-2', 2n, {
      kind: 'message_turn',
      phase: 'streaming',
      turn: messageTurn('acp-2', 'assistant', [
        { type: 'text', text: 'working' },
      ]),
    });
    const idle = emptyDetail([user, assistant]);
    idle.timeline.last_sequence = 2n;
    const idleState = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: idle,
    });
    expect(
      timelineTurnsForEntry(entryOf(idleState)).map((row) => row.phase)
    ).toEqual(['settled', 'settled']);

    const live = emptyDetail([user, assistant]);
    live.timeline.last_sequence = 2n;
    live.in_flight_user_turn_id = 'turn-1';
    const liveState = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: live,
    });
    expect(
      timelineTurnsForEntry(entryOf(liveState)).map((row) => row.phase)
    ).toEqual(['streaming', 'streaming']);
  });

  it('shows the first prompt once when the session seed and the live user match', () => {
    let state = loaded([userRow(CONVERSATION_ID, 'hello', 1n)]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [{ op: 'upsert', row: streamingUser('turn-1', 'hello', 2n) }],
        2n
      ),
    });
    const users = timelineTurnsForEntry(entryOf(state)).filter(
      (row) => row.turn.role === 'user'
    );
    expect(users.map((row) => row.turn.id)).toEqual(['turn-1:user']);
    expect(textOf(users[0]?.turn.blocks ?? [])).toBe('hello');
  });

  it('keeps two intentional copies of the same prompt', () => {
    const state = loaded([
      userRow('t1', 'same', 1n),
      userRow('t2', 'same', 2n),
    ]);
    const users = timelineTurnsForEntry(entryOf(state)).filter(
      (row) => row.turn.role === 'user'
    );
    expect(users.map((row) => textOf(row.turn.blocks))).toEqual([
      'same',
      'same',
    ]);
  });

  it('keeps the next user visible when a file refresh starts the reply without that prompt', () => {
    let state = loaded([
      userRow('t1', 'first', 1n),
      assistantRow('t1', [{ type: 'text', text: 'done' }], 2n),
    ]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [{ op: 'upsert', row: streamingUser('t2', 'second', 3n) }],
        3n
      ),
    });
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'append_text',
            row_id: 't2:assistant',
            revision: 4n,
            stream: 'text',
            delta: 'working',
          },
        ],
        3n
      ),
    });
    const detail = emptyDetail([
      userRow('acp-1', 'first', 1n),
      assistantRow('acp-2', [{ type: 'text', text: 'done' }], 2n),
      assistantRow(
        'acp-3',
        [{ type: 'text', text: 'working' }],
        3n,
        'streaming'
      ),
    ]);
    detail.timeline.last_sequence = 3n;
    state = conversationStoreReducer(state, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail,
    });
    const turns = timelineTurnsForEntry(entryOf(state));
    expect(
      turns
        .filter((row) => row.turn.role === 'user')
        .map((row) => textOf(row.turn.blocks))
    ).toEqual(['first', 'second']);
    expect(
      turns.filter(
        (row) =>
          row.turn.role === 'assistant' &&
          textOf(row.turn.blocks).includes('working')
      )
    ).toHaveLength(1);
    const second = turns.find((row) => textOf(row.turn.blocks) === 'second');
    expect(second?.phase).toBe('streaming');
  });

  it('does not grow a settled assistant with the next turn’s stream', () => {
    let state = loaded([
      userRow('t1', 'A', 1n),
      assistantRow('t1', [{ type: 'text', text: 'answer-A' }], 2n),
    ]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: timelineRow('t2:user', 3n, {
              kind: 'message_turn',
              phase: 'streaming',
              turn: messageTurn('t2:user', 'user', [
                { type: 'text', text: 'B' },
              ]),
            }),
          },
          {
            op: 'append_text',
            row_id: 't1:assistant',
            revision: 4n,
            stream: 'text',
            delta: 'answer-B',
          },
        ],
        4n
      ),
    });
    const turns = timelineTurnsForEntry(entryOf(state));
    const byId = Object.fromEntries(
      turns.map((row) => [row.turn.id, textOf(row.turn.blocks)])
    );
    expect(byId['t1:assistant']).toBe('answer-A');
    expect(byId['t2:assistant'] ?? '').toBe('');
    expect(entryOf(state).liveText['t2:assistant']).toBeUndefined();
    expect(
      turns.filter((row) => row.turn.role === 'user').map((row) => row.turn.id)
    ).toEqual(['t1:user', 't2:user']);
  });

  it('drops a late first-turn append instead of grafting it onto the second turn', () => {
    let state = loaded([
      userRow('t1', 'A', 1n),
      assistantRow('t1', [{ type: 'text', text: 'answer-A' }], 2n),
      userRow('t2', 'B', 3n),
    ]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'append_text',
            row_id: 't1:assistant',
            revision: 4n,
            stream: 'text',
            delta: 'late-A',
          },
          {
            op: 'append_text',
            row_id: 't2:assistant',
            revision: 5n,
            stream: 'text',
            delta: 'answer-B',
          },
        ],
        5n
      ),
    });
    const turns = timelineTurnsForEntry(entryOf(state));
    const byId = Object.fromEntries(
      turns.map((row) => [row.turn.id, textOf(row.turn.blocks)])
    );
    expect(byId['t1:assistant']).toBe('answer-A');
    expect(byId['t2:assistant']).toBe('answer-B');
    expect(entryOf(state).liveText['t1:assistant']).toBeUndefined();
  });

  it('keeps in-flight overlay text when a detail reload does not yet include it', () => {
    let state = loaded([userRow('t2', 'B', 3n)]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'append_text',
            row_id: 't2:assistant',
            revision: 4n,
            stream: 'text',
            delta: 'answer-B',
          },
        ],
        4n
      ),
    });
    const detail = emptyDetail([
      userRow('t1', 'A', 1n),
      assistantRow('t1', [{ type: 'text', text: 'answer-A' }], 2n),
      userRow('t2', 'B', 3n),
    ]);
    detail.timeline.last_sequence = 4n;
    state = conversationStoreReducer(state, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail,
    });
    expect(entryOf(state).liveText['t2:assistant']?.text).toBe('answer-B');
    const turns = timelineTurnsForEntry(entryOf(state));
    const byId = Object.fromEntries(
      turns.map((row) => [row.turn.id, textOf(row.turn.blocks)])
    );
    expect(byId['t1:assistant']).toBe('answer-A');
    expect(byId['t2:assistant']).toBe('answer-B');
  });

  it('keeps later optimistic user turns after an earlier streaming turn', () => {
    let state = loaded([userRow('t1', 'A', 50n)]);
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn('optimistic-b', 'user', [{ type: 'text', text: 'B' }]),
    });
    const users = timelineItemsForEntry(entryOf(state)).flatMap((item) =>
      item.kind === 'message' && item.item.turn.role === 'user'
        ? [item.item.turn.blocks[0]]
        : []
    );
    expect(users).toEqual([
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
    ]);
  });

  it('interleaves side rows with messages by revision', () => {
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
    const terminal: TimelineRow = timelineRow('term:t1', 3n, {
      kind: 'terminal_summary',
      terminal: {
        terminal_id: 't1',
        command: 'ls',
        status: 'exited',
        output_summary: 'ok',
        output_truncated: false,
      },
    });
    const state = loaded([
      userRow('t1', 'run it', 1n),
      permission,
      terminal,
      assistantRow('t1', [{ type: 'text', text: 'done' }], 4n),
    ]);
    expect(
      timelineItemsForEntry(entryOf(state)).map((item) =>
        item.kind === 'message' ? item.item.turn.role : item.row.row.kind
      )
    ).toEqual(['user', 'terminal_summary', 'assistant']);
  });

  it('deterministically interleaves messages and side rows without inverting message order across optimistic and revision-0 turns', () => {
    const terminalEarly: TimelineRow = timelineRow('term:early', 10n, {
      kind: 'terminal_summary',
      terminal: {
        terminal_id: 't-early',
        command: 'pwd',
        status: 'exited',
        output_summary: '/repo',
        output_truncated: false,
      },
    });
    const terminalMid: TimelineRow = timelineRow('term:mid', 55n, {
      kind: 'terminal_summary',
      terminal: {
        terminal_id: 't-mid',
        command: 'git status',
        status: 'exited',
        output_summary: 'clean',
        output_truncated: false,
      },
    });
    const zeroRevisionTrailingUser: TimelineRow = timelineRow('t2:user', 0n, {
      kind: 'message_turn',
      phase: 'optimistic',
      turn: messageTurn('t2:user', 'user', [
        { type: 'text', text: 'zero-rev' },
      ]),
    });
    let state = loaded([
      userRow('t1', 'first', 50n),
      assistantRow('t1', [{ type: 'text', text: 'first-reply' }], 20n),
      terminalMid,
      terminalEarly,
      zeroRevisionTrailingUser,
    ]);
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn('optimistic-3', 'user', [
        { type: 'text', text: 'optimistic-follow-up' },
      ]),
    });

    const items = timelineItemsForEntry(entryOf(state));
    expect(
      items.map((item) =>
        item.kind === 'message'
          ? `${item.item.turn.role}:${textOf(item.item.turn.blocks)}`
          : `side:${item.row.row_id}`
      )
    ).toEqual([
      'side:term:early',
      'user:first',
      'assistant:first-reply',
      'side:term:mid',
      'user:zero-rev',
      'user:optimistic-follow-up',
      'assistant:',
    ]);
  });

  it('does not trigger a false sequence gap when previous_sequence matches local cursor across coalesced or no-op sequences', () => {
    let state = loaded([userRow('t1', 'q', 1n)]);
    expect(entryOf(state).lastSequence).toBe(1n);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: assistantRow(
              't1',
              [{ type: 'text', text: 'coalesced' }],
              15n,
              'streaming'
            ),
          },
        ],
        15n,
        { previous_sequence: 1n }
      ),
    });
    expect(entryOf(state).gap).toEqual({ kind: 'none' });
    expect(entryOf(state).lastSequence).toBe(15n);
  });

  it('preserves sideRowsForEntry array identity across streaming message row updates', () => {
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
    let state = loaded([
      userRow('t1', 'q', 1n),
      permission,
      assistantRow('t1', [{ type: 'text', text: 'hel' }], 3n, 'streaming'),
    ]);
    const firstSideRows = sideRowsForEntry(entryOf(state));
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'upsert',
            row: assistantRow(
              't1',
              [{ type: 'text', text: 'hello' }],
              4n,
              'streaming'
            ),
          },
        ],
        4n
      ),
    });
    const secondSideRows = sideRowsForEntry(entryOf(state));
    expect(secondSideRows).toBe(firstSideRows);
  });

  it('times a live assistant from its user turn instead of the unix epoch', () => {
    let state = loaded([userRow('t1', 'q', 1n)]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'patch_blocks',
            row_id: 't1:assistant',
            revision: 2n,
            phase: 'streaming',
            blocks: [
              {
                type: 'tool_use',
                tool_name: 'Read',
                tool_use_id: 'call-1',
                input_preview: '{}',
                meta: null,
              },
            ],
          },
        ],
        2n
      ),
    });
    const assistant = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    expect(assistant?.turn.timestamp).toBe('2026-07-03T00:00:00.000Z');

    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'patch_blocks',
            row_id: 't1:assistant',
            revision: 3n,
            phase: 'streaming',
            blocks: [
              {
                type: 'tool_use',
                tool_name: 'Read file',
                tool_use_id: 'call-1',
                input_preview: '{}',
                meta: null,
              },
            ],
          },
        ],
        3n
      ),
    });
    const patched = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    expect(patched?.turn.timestamp).toBe('2026-07-03T00:00:00.000Z');
  });

  it('merges a tool patch by tool id and keeps streamed text', () => {
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
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'patch_blocks',
            row_id: 't1:assistant',
            revision: 3n,
            phase: 'streaming',
            blocks: [
              {
                type: 'tool_use',
                tool_name: 'Read',
                tool_use_id: 'call-1',
                input_preview: '{}',
                meta: null,
              },
            ],
          },
        ],
        3n
      ),
    });
    const assistant = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    expect(textOf(assistant?.turn.blocks ?? [])).toContain('hello');
    expect(assistant?.turn.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool_use',
          tool_use_id: 'call-1',
          tool_name: 'Read',
        }),
      ])
    );

    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'patch_blocks',
            row_id: 't1:assistant',
            revision: 4n,
            phase: 'streaming',
            blocks: [
              {
                type: 'tool_use',
                tool_name: 'Read file',
                tool_use_id: 'call-1',
                input_preview: '{}',
                meta: null,
              },
              {
                type: 'tool_result',
                tool_use_id: 'call-1',
                output_preview: 'ok',
                is_error: false,
              },
            ],
          },
        ],
        4n
      ),
    });
    const patched = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    const toolUses = (patched?.turn.blocks ?? []).filter(
      (block) => block.type === 'tool_use' && block.tool_use_id === 'call-1'
    );
    expect(toolUses).toEqual([
      expect.objectContaining({ tool_name: 'Read file' }),
    ]);
    expect(
      patched?.turn.blocks.some((block) => block.type === 'tool_result')
    ).toBe(true);
    expect(textOf(patched?.turn.blocks ?? [])).toContain('hello');
  });

  it('keeps the open timeline window so a fat last turn does not hide earlier turns', () => {
    const fat = 'x'.repeat(32 * 1024);
    const rows = Array.from({ length: 40 }, (_, index) =>
      userRow(`t${index}`, fat, BigInt(index + 1))
    );
    const state = loaded(rows);
    const entry = entryOf(state);
    expect(entry.rows).toHaveLength(40);
    expect(entry.rows[0]?.row_id).toBe('t0:user');
    expect(entry.rows.at(-1)?.row_id).toBe('t39:user');
  });

  it('replaces paged rows when a later tail window arrives', () => {
    const tail = [userRow('t16', 'tail', 16n), userRow('t17', 'latest', 17n)];
    let detail = emptyDetail(tail);
    detail.timeline.last_sequence = 17n;
    detail.timeline.older_cursor = '16';
    detail.timeline.truncated_from_start = true;
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail,
    });
    state = conversationStoreReducer(state, {
      type: 'upsert_rows',
      conversationId: CONVERSATION_ID,
      rows: [userRow('t0', 'first', 1n), userRow('t1', 'second', 2n)],
      lastSequence: 17n,
      olderCursor: '0',
      protectLoaded: true,
    });
    detail = emptyDetail(tail);
    detail.timeline.last_sequence = 17n;
    detail.timeline.older_cursor = '16';
    detail.timeline.truncated_from_start = true;
    state = conversationStoreReducer(state, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail,
    });
    expect(entryOf(state).rows.map((row) => row.row_id)).toEqual([
      't16:user',
      't17:user',
    ]);
    expect(entryOf(state).olderCursor).toBe('16');
  });

  it('replaces rows from the file when the database cursor matches and keeps the overlay', () => {
    let state = loaded([userRow('t1', 'q', 4n)]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'append_text',
            row_id: 't1:assistant',
            revision: 5n,
            stream: 'text',
            delta: 'hello',
          },
        ],
        4n
      ),
    });
    const detail = emptyDetail([userRow('acp-1', 'q', 1n)]);
    detail.timeline.last_sequence = 4n;
    state = conversationStoreReducer(state, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail,
    });
    expect(entryOf(state).rows.map((row) => row.row_id)).toEqual([
      'acp-1:user',
    ]);
    expect(entryOf(state).liveText['t1:assistant']?.text).toBe('hello');
  });

  it('does not amputate fat history on a keepRealtimeRows reload', () => {
    const fat = 'x'.repeat(32 * 1024);
    const rows = Array.from({ length: 40 }, (_, index) =>
      userRow(`t${index}`, fat, BigInt(index + 1))
    );
    let state = loaded(rows);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [{ op: 'upsert', row: userRow('t39', `${fat}!`, 41n) }],
        50n
      ),
    });
    const detail = emptyDetail(rows.slice(-16));
    detail.timeline.last_sequence = 40n;
    detail.timeline.older_cursor = '24';
    detail.timeline.truncated_from_start = true;
    state = conversationStoreReducer(state, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail,
    });
    expect(entryOf(state).rows).toHaveLength(40);
    expect(entryOf(state).rows[0]?.row_id).toBe('t0:user');
    expect(entryOf(state).rows.at(-1)?.row_id).toBe('t39:user');
  });

  it('keeps hydrated history when a later idle row-op arrives', () => {
    const fat = 'x'.repeat(32 * 1024);
    const rows = Array.from({ length: 40 }, (_, index) =>
      userRow(`t${index}`, fat, BigInt(index + 1))
    );
    let state = loaded(rows);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [{ op: 'upsert', row: userRow('t39', `${fat}!`, 41n) }],
        41n
      ),
    });
    expect(entryOf(state).rows).toHaveLength(40);
    expect(entryOf(state).rows[0]?.row_id).toBe('t0:user');
  });

  it('keeps every loaded row instead of trimming a retain budget', () => {
    const rows = Array.from({ length: 81 }, (_, index) =>
      userRow(`t${index}`, 'x', BigInt(index + 1))
    );
    const entry = entryOf(loaded(rows));
    expect(entry.rows).toHaveLength(81);
    expect(entry.rows[0]?.row_id).toBe('t0:user');
    expect(entry.olderCursor).toBeNull();
  });

  it('keeps the in-flight turn when its streaming payload exceeds the hot budget', () => {
    const fat = 'x'.repeat(32 * 1024);
    const blocks: ContentBlock[] = [
      { type: 'thinking', text: 'planning the work' },
      {
        type: 'tool_use',
        tool_name: 'Read',
        tool_use_id: 'call-early',
        input_preview: fat,
        meta: null,
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        type: 'tool_use' as const,
        tool_name: 'Read',
        tool_use_id: `call-${index}`,
        input_preview: fat,
        meta: null,
      })),
      { type: 'text', text: 'already streamed' },
    ];
    let state = loaded([
      userRow('old', 'previous question', 1n),
      userRow('live', 'please continue', 2n),
      assistantRow('live', blocks, 3n, 'streaming'),
    ]);
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(
        [
          {
            op: 'append_text',
            row_id: 'live:assistant',
            revision: 4n,
            stream: 'text',
            delta: ' and more',
          },
        ],
        4n
      ),
    });

    const turns = timelineTurnsForEntry(entryOf(state));
    expect(turns.some((row) => row.turn.id === 'old:user')).toBe(true);
    const user = turns.find((row) => row.turn.id === 'live:user');
    const assistant = turns.find((row) => row.turn.id === 'live:assistant');
    expect(user?.turn.blocks).toEqual([
      expect.objectContaining({ type: 'text', text: 'please continue' }),
    ]);
    expect(assistant?.phase).toBe('streaming');
    expect(
      assistant?.turn.blocks.some(
        (block) =>
          block.type === 'thinking' && block.text === 'planning the work'
      )
    ).toBe(true);
    expect(
      assistant?.turn.blocks.some(
        (block) =>
          block.type === 'tool_use' && block.tool_use_id === 'call-early'
      )
    ).toBe(true);
    expect(assistant?.turn.blocks.length).toBe(blocks.length);
    expect(textOf(assistant?.turn.blocks ?? [])).toBe(
      'already streamed and more'
    );
  });

  it('keeps already-rendered history turns while a later turn is streaming over budget', () => {
    const fat = 'x'.repeat(32 * 1024);
    const liveBlocks: ContentBlock[] = Array.from(
      { length: 40 },
      (_, index) => ({
        type: 'tool_use' as const,
        tool_name: 'Read',
        tool_use_id: `live-${index}`,
        input_preview: fat,
        meta: null,
      })
    );
    liveBlocks.push({ type: 'text', text: 'streaming now' });
    const state = loaded([
      userRow('t1', 'first question', 1n),
      assistantRow(
        't1',
        [{ type: 'text', text: 'first answer' }],
        2n,
        'settled'
      ),
      userRow('t2', 'second question', 3n),
      assistantRow(
        't2',
        [{ type: 'text', text: 'second answer' }],
        4n,
        'settled'
      ),
      userRow('t3', 'third question', 5n),
      assistantRow('t3', liveBlocks, 6n, 'streaming'),
    ]);
    const turns = timelineTurnsForEntry(entryOf(state));
    expect(turns.map((row) => row.turn.id)).toEqual([
      't1:user',
      't1:assistant',
      't2:user',
      't2:assistant',
      't3:user',
      't3:assistant',
    ]);
    expect(entryOf(state).olderCursor).toBeNull();
  });

  it('does not amputate a leftover settled turn that exceeds the byte budget', () => {
    const fat = 'x'.repeat(32 * 1024);
    const blocks: ContentBlock[] = [
      { type: 'thinking', text: 'planning the work' },
      ...Array.from({ length: 40 }, (_, index) => ({
        type: 'tool_use' as const,
        tool_name: 'Read',
        tool_use_id: `call-${index}`,
        input_preview: fat,
        meta: null,
      })),
      { type: 'text', text: 'final answer' },
    ];
    const state = loaded([assistantRow('solo', blocks, 1n, 'settled')]);
    const assistant = timelineTurnsForEntry(entryOf(state))[0];
    expect(assistant?.turn.blocks).toHaveLength(blocks.length);
    expect(
      assistant?.turn.blocks.some(
        (block) =>
          block.type === 'thinking' && block.text === 'planning the work'
      )
    ).toBe(true);
    expect(textOf(assistant?.turn.blocks ?? [])).toBe('final answer');
  });

  it('keeps a prepended older page in front of the open window', () => {
    const tail = Array.from({ length: 4 }, (_, index) =>
      userRow(`tail${index}`, 'x', BigInt(index + 20))
    );
    let state = loaded(tail);
    const older = Array.from({ length: 5 }, (_, index) =>
      userRow(`old${index}`, 'y', BigInt(index + 1))
    );
    state = conversationStoreReducer(state, {
      type: 'upsert_rows',
      conversationId: CONVERSATION_ID,
      rows: older,
      lastSequence: entryOf(state).lastSequence,
      protectLoaded: true,
    });
    const entry = entryOf(state);
    expect(entry.rows.length).toBe(9);
    expect(entry.rows[0]?.row_id).toBe('old0:user');
    expect(entry.rows.at(-1)?.row_id).toBe('tail3:user');
    expect(entry.olderTurnsPrependEpoch).toBe(1);
  });
});

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
}

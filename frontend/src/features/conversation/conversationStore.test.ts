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

  it('merges overlay text into an earlier assistant text block after tools', () => {
    let state = loaded([
      userRow('t1', 'q', 1n),
      assistantRow(
        't1',
        [
          { type: 'text', text: '项目已启动完成。' },
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
            stream: 'text',
            delta: '项目已启动完成。',
          },
        ],
        3n
      ),
    });
    const assistant = timelineTurnsForEntry(entryOf(state)).find(
      (row) => row.turn.role === 'assistant'
    );
    const texts = (assistant?.turn.blocks ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text);
    expect(texts).toEqual(['项目已启动完成。']);
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
});

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('');
}

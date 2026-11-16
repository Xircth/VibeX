import { describe, expect, it } from 'vitest';
import type {
  ContentBlock,
  ConversationTimelineRow,
  DbConversationDetail,
  MessageTurn,
  TimelineRow,
} from 'shared/types';
import {
  combineWindowAndLiveRows,
  normalizePromptMatchText,
  preserveStructuredUserText,
  promptsMatch,
  userTurnText,
} from './queue';
import {
  conversationStoreReducer,
  emptyConversationStoreState,
} from './turnLifecycle';
import { timelineTurnsForEntry } from './selectors';

const CONVERSATION_ID = 'conversation-1';

function timelineRow(
  rowId: string,
  revision: bigint,
  row: ConversationTimelineRow
): TimelineRow {
  return { row_id: rowId, revision, row };
}

function messageTurn(
  id: string,
  role: 'user' | 'assistant',
  blocks: ContentBlock[],
  timestamp = '2026-07-03T00:00:00.000Z'
): MessageTurn {
  return {
    id,
    role,
    blocks,
    timestamp,
  };
}

function emptyDetail(
  rows: TimelineRow[] = [],
  lastSequence?: bigint
): DbConversationDetail {
  return {
    summary: {
      id: CONVERSATION_ID,
      workspace_id: 'workspace-1',
      task_id: null,
      title: 'Conversation',
      title_locked: false,
      status: 'inprogress',
      agent_id: 'claude_code' as const,
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
      last_sequence: lastSequence ?? (rows.length ? 10n : 0n),
      rows,
      truncated_from_start: false,
    },
    turns_offset: 0,
    turns_total: 0,
    user_turns_before_offset: 0,
    projection_version: 2,
    session_config_options: [],
  };
}

describe('skill + @file structured token preservation & single-authority convergence (Issue #71)', () => {
  const structuredDisplayPrompt =
    '[/:cy-cover-designer](/cy-cover-designer) [@:xxx.srt](xxx.srt)';
  const normalizedPlainPrompt = '/cy-cover-designer xxx.srt';
  const resourceLinkBlock = '[xxx.srt](<file:///C:/project/xxx.srt>)';

  it('matches user turns with standalone resource_link block against normalized live user text', () => {
    const windowUser = messageTurn('turn-1:user', 'user', [
      { type: 'text', text: structuredDisplayPrompt },
      { type: 'text', text: resourceLinkBlock },
    ]);
    const liveUser = messageTurn('turn-1:user', 'user', [
      { type: 'text', text: structuredDisplayPrompt },
    ]);

    expect(normalizePromptMatchText(userTurnText(windowUser))).toBe(
      normalizePromptMatchText(userTurnText(liveUser))
    );
    expect(promptsMatch(userTurnText(windowUser), userTurnText(liveUser))).toBe(
      true
    );
  });

  it('preserves structured slash/skill tokens across normalized backend user-row upserts', () => {
    const existing = timelineRow('turn-1:user', 1n, {
      kind: 'message_turn',
      phase: 'streaming',
      turn: messageTurn('turn-1:user', 'user', [
        { type: 'text', text: structuredDisplayPrompt },
      ]),
    });
    const incoming = timelineRow('turn-1:user', 2n, {
      kind: 'message_turn',
      phase: 'settled',
      turn: messageTurn('turn-1:user', 'user', [
        { type: 'text', text: normalizedPlainPrompt },
      ]),
    });

    const preserved = preserveStructuredUserText(existing, incoming);
    expect(preserved.revision).toBe(2n);
    expect(preserved.row.kind).toBe('message_turn');
    if (preserved.row.kind === 'message_turn') {
      expect(preserved.row.phase).toBe('settled');
      expect(preserved.row.turn.blocks).toEqual([
        { type: 'text', text: structuredDisplayPrompt },
      ]);
    }
  });

  it('converges canonical SQLite windowRows and liveRows by row_id + revision without duplicating turns', () => {
    const windowRows: TimelineRow[] = [
      timelineRow('turn-1:user', 1n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'turn-1:user',
          'user',
          [{ type: 'text', text: normalizedPlainPrompt }],
          '2026-07-03T00:00:00.000Z'
        ),
      }),
      timelineRow('turn-1:assistant', 2n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'turn-1:assistant',
          'assistant',
          [{ type: 'text', text: 'Here are the 3 cover options.' }],
          '2026-07-03T00:00:05.000Z'
        ),
      }),
      timelineRow('turn-2:user', 3n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'turn-2:user',
          'user',
          [{ type: 'text', text: 'Option B' }],
          '2026-07-03T00:01:00.000Z'
        ),
      }),
      timelineRow('turn-2:assistant', 4n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'turn-2:assistant',
          'assistant',
          [{ type: 'text', text: 'Generated Option B cover.' }],
          '2026-07-03T00:01:10.000Z'
        ),
      }),
    ];

    const liveRows: TimelineRow[] = [
      timelineRow('turn-1:user', 1n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'turn-1:user',
          'user',
          [{ type: 'text', text: structuredDisplayPrompt }],
          '2026-07-03T00:00:00.000Z'
        ),
      }),
      timelineRow('turn-1:assistant', 2n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'turn-1:assistant',
          'assistant',
          [{ type: 'text', text: 'Here are the 3 cover options.' }],
          '2026-07-03T00:00:05.000Z'
        ),
      }),
    ];

    const combined = combineWindowAndLiveRows(
      CONVERSATION_ID,
      windowRows,
      liveRows,
      {}
    );
    expect(combined.map((row) => row.row_id)).toEqual([
      'turn-1:user',
      'turn-1:assistant',
      'turn-2:user',
      'turn-2:assistant',
    ]);

    // Verify load_success prunes converged Turn 1 from liveRows while preserving structured user text
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'row_ops',
      batch: {
        conversation_id: CONVERSATION_ID,
        last_sequence: 2n,
        ops: liveRows.map((row) => ({ op: 'upsert' as const, row })),
        session_modes: null,
        session_config_options: null,
      },
    });
    expect(
      state.byConversationId[CONVERSATION_ID]?.liveRows.map((r) => r.row_id)
    ).toEqual(['turn-1:user', 'turn-1:assistant']);

    state = conversationStoreReducer(state, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: emptyDetail(windowRows, 4n),
    });

    const entry = state.byConversationId[CONVERSATION_ID]!;
    expect(entry.liveRows).toEqual([]);
    expect(entry.rows.map((row) => row.row_id)).toEqual([
      'turn-1:user',
      'turn-1:assistant',
      'turn-2:user',
      'turn-2:assistant',
    ]);
    const firstRow = entry.rows[0];
    expect(firstRow?.row.kind).toBe('message_turn');
    if (firstRow?.row.kind === 'message_turn') {
      expect(firstRow.row.turn.blocks).toEqual([
        { type: 'text', text: structuredDisplayPrompt },
      ]);
    }
  });
});

describe('turn chronological ordering regressions (new turn never placed before earlier turns)', () => {
  it('never inserts a newly sent turn before an earlier turn when timestamps have sub-second skew or whole-second truncation', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: emptyDetail([], 0n),
    });

    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: {
        conversation_id: CONVERSATION_ID,
        last_sequence: 2n,
        ops: [
          {
            op: 'upsert',
            row: timelineRow('turn-1:user', 1n, {
              kind: 'message_turn',
              phase: 'settled',
              turn: messageTurn(
                'turn-1:user',
                'user',
                [{ type: 'text', text: 'First turn prompt' }],
                '2026-07-03T10:00:05.650Z'
              ),
            }),
          },
          {
            op: 'upsert',
            row: timelineRow('turn-1:assistant', 2n, {
              kind: 'message_turn',
              phase: 'settled',
              turn: messageTurn(
                'turn-1:assistant',
                'assistant',
                [{ type: 'text', text: 'First turn reply' }],
                '2026-07-03T10:00:05.800Z'
              ),
            }),
          },
        ],
        session_modes: null,
        session_config_options: null,
      },
    });

    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: {
        conversation_id: CONVERSATION_ID,
        last_sequence: 4n,
        ops: [
          {
            op: 'upsert',
            row: timelineRow('turn-2:user', 3n, {
              kind: 'message_turn',
              phase: 'streaming',
              turn: messageTurn(
                'turn-2:user',
                'user',
                [{ type: 'text', text: 'Second turn prompt' }],
                '2026-07-03T10:00:05.000Z'
              ),
            }),
          },
          {
            op: 'upsert',
            row: timelineRow('turn-2:assistant', 4n, {
              kind: 'message_turn',
              phase: 'streaming',
              turn: messageTurn(
                'turn-2:assistant',
                'assistant',
                [{ type: 'text', text: 'Second turn reply' }],
                '2026-07-03T10:00:05.000Z'
              ),
            }),
          },
        ],
        session_modes: null,
        session_config_options: null,
      },
    });

    const entry = state.byConversationId[CONVERSATION_ID]!;
    expect(entry.rows.map((row) => row.row_id)).toEqual([
      'turn-1:user',
      'turn-1:assistant',
      'turn-2:user',
      'turn-2:assistant',
    ]);
  });

  it('never splices a new turn into an earlier unanswered/interrupted user round in windowRows', () => {
    const windowRows: TimelineRow[] = [
      timelineRow('turn-1:user', 1n, {
        kind: 'message_turn',
        phase: 'interrupted',
        turn: messageTurn(
          'turn-1:user',
          'user',
          [{ type: 'text', text: '继续' }],
          '2026-07-03T10:00:00.000Z'
        ),
      }),
      timelineRow('turn-2:user', 2n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'turn-2:user',
          'user',
          [{ type: 'text', text: 'Explain the bug' }],
          '2026-07-03T10:01:00.000Z'
        ),
      }),
      timelineRow('turn-2:assistant', 3n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'turn-2:assistant',
          'assistant',
          [{ type: 'text', text: 'Here is the explanation.' }],
          '2026-07-03T10:01:05.000Z'
        ),
      }),
    ];

    const orphanLiveAssistant: TimelineRow[] = [
      timelineRow('turn-3:assistant', 4n, {
        kind: 'message_turn',
        phase: 'streaming',
        turn: messageTurn(
          'turn-3:assistant',
          'assistant',
          [{ type: 'text', text: 'New turn 3 streaming...' }],
          '2026-07-03T10:02:00.000Z'
        ),
      }),
    ];

    const combinedOrphan = combineWindowAndLiveRows(
      CONVERSATION_ID,
      windowRows,
      orphanLiveAssistant,
      {}
    );
    expect(combinedOrphan.map((row) => row.row_id)).toEqual([
      'turn-1:user',
      'turn-2:user',
      'turn-2:assistant',
      'turn-3:assistant',
    ]);

    const repeatedPromptLive: TimelineRow[] = [
      timelineRow('turn-3:user', 4n, {
        kind: 'message_turn',
        phase: 'streaming',
        turn: messageTurn(
          'turn-3:user',
          'user',
          [{ type: 'text', text: '继续' }],
          ''
        ),
      }),
      timelineRow('turn-3:assistant', 5n, {
        kind: 'message_turn',
        phase: 'streaming',
        turn: messageTurn(
          'turn-3:assistant',
          'assistant',
          [{ type: 'text', text: 'Turn 3 reply' }],
          ''
        ),
      }),
    ];

    const combinedRepeated = combineWindowAndLiveRows(
      CONVERSATION_ID,
      windowRows,
      repeatedPromptLive,
      {}
    );
    expect(combinedRepeated.map((row) => row.row_id)).toEqual([
      'turn-1:user',
      'turn-2:user',
      'turn-2:assistant',
      'turn-3:user',
      'turn-3:assistant',
    ]);
  });

  it('never splices a new optimistic user turn in front of an earlier orphan assistant in history', () => {
    const windowRows: TimelineRow[] = [
      timelineRow('turn-0:assistant', 1n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'turn-0:assistant',
          'assistant',
          [{ type: 'text', text: 'Old orphan assistant at window start' }],
          '2026-07-03T10:00:00.000Z'
        ),
      }),
      timelineRow('turn-1:user', 2n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'turn-1:user',
          'user',
          [{ type: 'text', text: 'Turn 1 user' }],
          '2026-07-03T10:01:00.000Z'
        ),
      }),
      timelineRow('turn-1:assistant', 3n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'turn-1:assistant',
          'assistant',
          [{ type: 'text', text: 'Turn 1 assistant' }],
          '2026-07-03T10:01:05.000Z'
        ),
      }),
    ];

    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: emptyDetail(windowRows, 3n),
    });

    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn(
        'optimistic-turn-2',
        'user',
        [{ type: 'text', text: 'Newly sent turn 2' }],
        '2026-07-03T10:02:00.000Z'
      ),
    });

    const entry = state.byConversationId[CONVERSATION_ID]!;
    const turns = timelineTurnsForEntry(entry);
    expect(turns.map((item) => item.turn.id)).toEqual([
      'turn-0:assistant',
      'turn-1:user',
      'turn-1:assistant',
      'optimistic-turn-2',
    ]);
  });

  it('preserves a newly sent optimistic turn with repeated text even with 0ms timestamp delta when a stale window reload only contains the earlier turn', () => {
    const earlierWindowRows: TimelineRow[] = [
      timelineRow('turn-1:user', 1n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'turn-1:user',
          'user',
          [{ type: 'text', text: '继续' }],
          '2026-07-03T10:00:00.000Z'
        ),
      }),
      timelineRow('turn-1:assistant', 2n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'turn-1:assistant',
          'assistant',
          [{ type: 'text', text: 'Turn 1 reply' }],
          '2026-07-03T10:00:00.000Z'
        ),
      }),
    ];

    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: emptyDetail(earlierWindowRows, 2n),
    });

    // User immediately sends a new turn with the exact same text and identical timestamp (0ms delta)
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn(
        'optimistic-2',
        'user',
        [{ type: 'text', text: '继续' }],
        '2026-07-03T10:00:00.000Z'
      ),
    });

    // A background load_success arrives before Turn 2 is projected
    state = conversationStoreReducer(state, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: emptyDetail(earlierWindowRows, 2n),
    });

    const entry = state.byConversationId[CONVERSATION_ID]!;
    expect(entry.optimisticTurns.map((t) => t.id)).toEqual(['optimistic-2']);
  });

  it('does not let the {conversationId}:user session seed row strip optimistic images or drop the pending assistant bubble', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn(
        'optimistic-seed-1',
        'user',
        [
          { type: 'text', text: 'Inspect screenshot' },
          {
            type: 'image',
            data: '',
            mime_type: 'image/png',
            uri: '.vibe-images/shot.png',
          },
        ],
        '2026-07-03T10:00:00.000Z'
      ),
    });

    // Session detail loads with only the text-only {conversationId}:user seed row before turn projection starts
    const seedRow = timelineRow(`${CONVERSATION_ID}:user`, 1n, {
      kind: 'message_turn',
      phase: 'settled',
      turn: messageTurn(
        `${CONVERSATION_ID}:user`,
        'user',
        [{ type: 'text', text: 'Inspect screenshot' }],
        '2026-07-03T10:00:00.000Z'
      ),
    });

    state = conversationStoreReducer(state, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: emptyDetail([seedRow], 1n),
    });

    const entry = state.byConversationId[CONVERSATION_ID]!;
    expect(entry.optimisticTurns).toHaveLength(1);
    const turns = timelineTurnsForEntry(entry);
    const user = turns.find((t) => t.turn.role === 'user');
    const assistant = turns.find((t) => t.turn.role === 'assistant');
    expect(user?.turn.blocks).toEqual([
      { type: 'text', text: 'Inspect screenshot' },
      {
        type: 'image',
        data: '',
        mime_type: 'image/png',
        uri: '.vibe-images/shot.png',
      },
    ]);
    expect(assistant?.phase).toBe('streaming');
  });

  it('matches image-only optimistic turns by image count and URI basename instead of blindly matching empty text', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: emptyDetail([], 0n),
    });

    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn(
        'opt-img-alpha',
        'user',
        [
          {
            type: 'image',
            data: '',
            mime_type: 'image/png',
            uri: '.vibe-images/alpha.png',
          },
        ],
        '2026-07-03T10:00:00.000Z'
      ),
    });
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn(
        'opt-img-beta',
        'user',
        [
          {
            type: 'image',
            data: '',
            mime_type: 'image/png',
            uri: '.vibe-images/beta.png',
          },
          {
            type: 'image',
            data: '',
            mime_type: 'image/png',
            uri: '.vibe-images/gamma.png',
          },
        ],
        '2026-07-03T10:00:01.000Z'
      ),
    });

    // Authoritative user row for the 2-image beta+gamma message arrives first
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: {
        conversation_id: CONVERSATION_ID,
        last_sequence: 1n,
        ops: [
          {
            op: 'upsert',
            row: timelineRow('turn-beta:user', 1n, {
              kind: 'message_turn',
              phase: 'streaming',
              turn: messageTurn('turn-beta:user', 'user', [
                {
                  type: 'image',
                  data: '',
                  mime_type: 'image/png',
                  uri: 'file:///workspace/.vibe-images/beta.png',
                },
                {
                  type: 'image',
                  data: '',
                  mime_type: 'image/png',
                  uri: 'file:///workspace/.vibe-images/gamma.png',
                },
              ]),
            }),
          },
        ],
        session_modes: null,
        session_config_options: null,
      },
    });

    const entry = state.byConversationId[CONVERSATION_ID]!;
    expect(entry.optimisticTurns.map((t) => t.id)).toEqual(['opt-img-alpha']);
  });
});

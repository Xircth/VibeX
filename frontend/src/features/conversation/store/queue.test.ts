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
  isLiveTurnConvergedInWindow,
  normalizePromptMatchText,
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

function emptyDetail(rows: TimelineRow[] = []): DbConversationDetail {
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
      last_sequence: rows.length ? 10n : 0n,
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

describe('skill + @file turn convergence (Issue #71)', () => {
  const structuredDisplayPrompt =
    '[/:cy-cover-designer](/cy-cover-designer) [@:xxx.srt](xxx.srt)';
  const resourceLinkBlock = '[xxx.srt](<file:///C:/project/xxx.srt>)';

  it('matches windowUser with standalone resource_link block against liveUser', () => {
    const windowUser = messageTurn('acp-0', 'user', [
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

  it('converges and aligns windowUser and liveUser without duplicating the skill turn at the bottom', () => {
    const windowRows: TimelineRow[] = [
      timelineRow('acp-0', 1n, {
        kind: 'message_turn',
        phase: 'persisted',
        turn: messageTurn(
          'acp-0',
          'user',
          [
            { type: 'text', text: structuredDisplayPrompt },
            { type: 'text', text: resourceLinkBlock },
          ],
          '2026-07-03T00:00:00.000Z'
        ),
      }),
      timelineRow('acp-1', 2n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'acp-1',
          'assistant',
          [{ type: 'text', text: 'Here are the 3 cover options.' }],
          '2026-07-03T00:00:05.000Z'
        ),
      }),
      timelineRow('acp-2', 3n, {
        kind: 'message_turn',
        phase: 'persisted',
        turn: messageTurn(
          'acp-2',
          'user',
          [{ type: 'text', text: 'Option B' }],
          '2026-07-03T00:01:00.000Z'
        ),
      }),
      timelineRow('acp-3', 4n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'acp-3',
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

    expect(
      isLiveTurnConvergedInWindow('turn-1', windowRows, liveRows, {})
    ).toBe(true);

    const combined = combineWindowAndLiveRows(
      CONVERSATION_ID,
      windowRows,
      liveRows,
      {}
    );
    expect(combined.map((row) => row.row_id)).toEqual([
      'acp-0',
      'acp-1',
      'acp-2',
      'acp-3',
    ]);

    // Verify load_success prunes Turn 1 from liveRows via pruneConvergedLiveState
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
      detail: emptyDetail(windowRows),
    });

    const entry = state.byConversationId[CONVERSATION_ID]!;
    expect(entry.liveRows).toEqual([]);
    expect(entry.rows.map((row) => row.row_id)).toEqual([
      'acp-0',
      'acp-1',
      'acp-2',
      'acp-3',
    ]);
  });
});

describe('turn chronological ordering regressions (new turn never placed before earlier turns)', () => {
  it('never inserts a newly sent turn before an earlier turn when timestamps have sub-second skew or whole-second truncation', () => {
    // Turn 1 had a client-synthesized millisecond timestamp (10:00:05.650Z),
    // while Turn 2 arrives from the backend with whole-second precision (10:00:05.000Z).
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: emptyDetail([]),
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
    // Turn 1 (acp-0) had no assistant reply (e.g. cancelled/interrupted earlier),
    // followed by Turn 2 (acp-1, acp-2). Now Turn 3 starts and its assistant row
    // arrives before its user row (or with the same prompt text).
    const windowRows: TimelineRow[] = [
      timelineRow('acp-0', 1n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'acp-0',
          'user',
          [{ type: 'text', text: '继续' }],
          '2026-07-03T10:00:00.000Z'
        ),
      }),
      timelineRow('acp-1', 2n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'acp-1',
          'user',
          [{ type: 'text', text: 'Explain the bug' }],
          '2026-07-03T10:01:00.000Z'
        ),
      }),
      timelineRow('acp-2', 3n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'acp-2',
          'assistant',
          [{ type: 'text', text: 'Here is the explanation.' }],
          '2026-07-03T10:01:05.000Z'
        ),
      }),
    ];

    // Case A: Turn 3's streaming assistant arrives before Turn 3's user row
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
      'acp-0',
      'acp-1',
      'acp-2',
      'turn-3:assistant',
    ]);

    // Case B: Turn 3 has the same prompt text '继续' as Turn 1 (acp-0), even if timestamps are missing
    const repeatedPromptLive: TimelineRow[] = [
      timelineRow('turn-3:user', 4n, {
        kind: 'message_turn',
        phase: 'streaming',
        turn: messageTurn('turn-3:user', 'user', [{ type: 'text', text: '继续' }], ''),
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
      'acp-0',
      'acp-1',
      'acp-2',
      'turn-3:user',
      'turn-3:assistant',
    ]);
  });

  it('never splices a new optimistic user turn in front of an earlier orphan assistant in history', () => {
    // Window starts with a settled orphan assistant from a paged boundary (`turn-0:assistant`),
    // followed by a completed Turn 1 (`turn-1:user`, `turn-1:assistant`).
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
      detail: emptyDetail(windowRows),
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
    // Verify via timelineTurnsForEntry that optimistic-turn-2 is at the tail after turn-1:assistant
    const turns = timelineTurnsForEntry(entry);
    expect(turns.map((item) => item.turn.id)).toEqual([
      'turn-0:assistant',
      'turn-1:user',
      'turn-1:assistant',
      'optimistic-turn-2',
    ]);
  });

  it('preserves a newly sent optimistic turn with repeated text when a stale window reload only contains the earlier turn', () => {
    const earlierWindowRows: TimelineRow[] = [
      timelineRow('acp-0', 1n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'acp-0',
          'user',
          [{ type: 'text', text: '继续' }],
          '2026-07-03T10:00:00.000Z'
        ),
      }),
      timelineRow('acp-1', 2n, {
        kind: 'message_turn',
        phase: 'settled',
        turn: messageTurn(
          'acp-1',
          'assistant',
          [{ type: 'text', text: 'Turn 1 reply' }],
          '2026-07-03T10:00:05.000Z'
        ),
      }),
    ];

    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: emptyDetail(earlierWindowRows),
    });

    // User sends a new turn with the same text '继续' 1 minute later
    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turn: messageTurn(
        'optimistic-2',
        'user',
        [{ type: 'text', text: '继续' }],
        '2026-07-03T10:01:00.000Z'
      ),
    });

    // A background load_success arrives before Turn 2 is written to the transcript file
    state = conversationStoreReducer(state, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: emptyDetail(earlierWindowRows),
    });

    const entry = state.byConversationId[CONVERSATION_ID]!;
    expect(entry.optimisticTurns.map((t) => t.id)).toEqual(['optimistic-2']);
  });
});


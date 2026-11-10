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

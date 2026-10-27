import { describe, expect, it } from 'vitest';
import type {
  ConversationRowOpBatch,
  DbConversationDetail,
  TimelineRow,
} from 'shared/types';
import {
  conversationStoreReducer,
  emptyConversationStoreState,
} from './conversationStore';

const CONVERSATION_ID = 'conversation-goal-async-1';

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
      created_at: '2026-10-27T00:00:00.000Z',
      updated_at: '2026-10-27T00:00:00.000Z',
    },
    turns: [],
    timeline: {
      conversation_id: CONVERSATION_ID,
      projection_version: 2,
      last_sequence: rows.length ? 1n : 0n,
      rows,
      truncated_from_start: false,
    },
    turns_offset: 0,
    turns_total: 0,
    user_turns_before_offset: 0,
    projection_version: 2,
    session_modes: { current: null, available: [] },
    session_config_options: [],
    available_commands: null,
    session_goal: {
      goal: { objective: 'Initial goal', status: 'active' },
      actions: ['pause', 'clear'],
    },
    async_tasks: [
      {
        id: 'task-1',
        task_type: 'bash',
        name: 'pnpm test',
        state: 'running',
        can_stop: true,
        phase: 'running',
        current_agent: null,
        last_tool_name: null,
        output_file_path: '/tmp/task-1.log',
        tool_call_id: 'call-1',
        usage: null,
      },
    ],
    prompt_suggestion: '运行测试并修复错误',
  };
}

function batch(
  lastSequence: bigint,
  extra: Partial<ConversationRowOpBatch> = {}
): ConversationRowOpBatch {
  return {
    conversation_id: CONVERSATION_ID,
    last_sequence: lastSequence,
    ops: [],
    session_modes: null,
    session_config_options: null,
    ...extra,
  };
}

describe('conversationStore goal, asyncTasks, and promptSuggestion', () => {
  it('hydrates sessionGoal, asyncTasks, and promptSuggestion on load_success and updates via row_ops', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: emptyDetail(),
    });

    const entry = state.byConversationId[CONVERSATION_ID];
    expect(entry?.sessionGoal).toEqual({
      goal: { objective: 'Initial goal', status: 'active' },
      actions: ['pause', 'clear'],
    });
    expect(entry?.asyncTasks).toHaveLength(1);
    expect(entry?.promptSuggestion).toBe('运行测试并修复错误');

    // Update goal and prompt_suggestion via unpersisted row_ops batch (sequence 0n)
    state = conversationStoreReducer(state, {
      type: 'row_ops',
      batch: batch(0n, {
        session_goal: {
          goal: { objective: 'Initial goal', status: 'paused' },
          actions: ['clear'],
        },
        prompt_suggestion: { suggestion: '继续执行当前目标' },
      }),
    });

    expect(state.byConversationId[CONVERSATION_ID]?.sessionGoal).toEqual({
      goal: { objective: 'Initial goal', status: 'paused' },
      actions: ['clear'],
    });
    expect(state.byConversationId[CONVERSATION_ID]?.promptSuggestion).toBe(
      '继续执行当前目标'
    );

    // Clear promptSuggestion explicitly
    state = conversationStoreReducer(state, {
      type: 'clear_prompt_suggestion',
      conversationId: CONVERSATION_ID,
    });
    expect(
      state.byConversationId[CONVERSATION_ID]?.promptSuggestion
    ).toBeNull();
  });

  it('clears promptSuggestion on optimistic_turn and user message turn upsert', () => {
    let state = conversationStoreReducer(emptyConversationStoreState, {
      type: 'load_success',
      conversationId: CONVERSATION_ID,
      detail: emptyDetail(),
    });
    expect(state.byConversationId[CONVERSATION_ID]?.promptSuggestion).toBe(
      '运行测试并修复错误'
    );

    state = conversationStoreReducer(state, {
      type: 'optimistic_turn',
      conversationId: CONVERSATION_ID,
      turnId: 'turn-1',
      text: 'Hello',
    });
    expect(
      state.byConversationId[CONVERSATION_ID]?.promptSuggestion
    ).toBeNull();
  });
});

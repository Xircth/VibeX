import { describe, expect, it } from 'vitest';
import type { ConversationTimelineTurn } from '@/features/conversation/conversationStore';
import {
  findInConversationTimeline,
  searchableTimelineFields,
} from './conversationFind';

function row(
  key: string,
  blocks: ConversationTimelineTurn['turn']['blocks']
): ConversationTimelineTurn {
  return {
    key,
    phase: 'settled',
    revision: 0n,
    turn: {
      id: key,
      role: 'assistant',
      blocks,
      timestamp: '2026-08-17T00:00:00.000Z',
    },
  };
}

describe('conversationFind', () => {
  const timeline = [
    row('user', [{ type: 'text', text: 'Please review the plan' }]),
    row('assistant', [
      { type: 'thinking', text: 'Need to inspect the plan status' },
      {
        type: 'plan',
        entries: [
          { content: 'Write tests', status: 'completed', priority: 'high' },
        ],
      },
      { type: 'text', text: 'Plan is ready.' },
      {
        type: 'tool_use',
        tool_name: 'read_file',
        tool_use_id: '1',
        input_preview: 'secret tool input',
      },
    ]),
  ];

  it('indexes user text, thinking, and plan entries only', () => {
    expect(searchableTimelineFields(timeline[1]).map((field) => field.field)).toEqual(
      ['thinking', 'plan', 'text']
    );
  });

  it('finds case-insensitive matches across visible fields', () => {
    expect(findInConversationTimeline(timeline, 'PLAN')).toEqual([
      { rowIndex: 0, field: 'text', start: 18, end: 22 },
      { rowIndex: 1, field: 'thinking', start: 20, end: 24 },
      { rowIndex: 1, field: 'text', start: 0, end: 4 },
    ]);
  });

  it('ignores empty queries and tool I/O', () => {
    expect(findInConversationTimeline(timeline, '   ')).toEqual([]);
    expect(findInConversationTimeline(timeline, 'secret tool input')).toEqual(
      []
    );
  });
});

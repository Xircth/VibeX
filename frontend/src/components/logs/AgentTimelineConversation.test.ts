import { describe, expect, it } from 'vitest';

import type { ConversationTimelineTurn } from '@/features/conversation/conversationStore';
import {
  getLatestTimelinePlanEntries,
  isEditableUserTimelineRow,
  isTimelineTurnInFlight,
  resolveConversationCollapsePreferences,
} from './AgentTimelineConversation';

function row(
  key: string,
  role: 'user' | 'assistant',
  phase: ConversationTimelineTurn['phase']
): ConversationTimelineTurn {
  return {
    key,
    phase,
    turn: {
      id: `${key}:${role}`,
      role,
      blocks: [],
      timestamp: '2026-07-22T00:00:00.000Z',
    },
  };
}

describe('AgentTimelineConversation edit policy', () => {
  it('keeps the last user message editable while the assistant is streaming', () => {
    const lastUser = row('turn-2', 'user', 'streaming');
    const pendingAssistant = row('turn-2', 'assistant', 'streaming');

    expect(isEditableUserTimelineRow(lastUser, lastUser.key)).toBe(true);
    expect(isEditableUserTimelineRow(pendingAssistant, lastUser.key)).toBe(
      false
    );
  });

  it('does not expose edit on an older user message', () => {
    expect(
      isEditableUserTimelineRow(row('turn-1', 'user', 'settled'), 'turn-2')
    ).toBe(false);
  });
});

describe('AgentTimelineConversation composer runtime bridge', () => {
  it('reports an active canonical turn even before legacy execution state catches up', () => {
    expect(
      isTimelineTurnInFlight([
        row('turn-2', 'user', 'streaming'),
        row('turn-2', 'assistant', 'streaming'),
      ])
    ).toBe(true);
  });

  it('exposes the latest visible plan to composer task controls', () => {
    const firstPlan = row('turn-1', 'assistant', 'settled');
    firstPlan.turn.blocks = [
      {
        type: 'plan',
        entries: [{ content: 'Inspect files', status: 'completed' }],
      },
    ];
    const latestPlan = row('turn-2', 'assistant', 'streaming');
    latestPlan.turn.blocks = [
      {
        type: 'plan',
        entries: [
          { content: 'Repair queue state', status: 'in_progress' },
          { content: 'Verify the composer', status: 'pending' },
        ],
      },
    ];

    expect(getLatestTimelinePlanEntries([firstPlan, latestPlan])).toEqual([
      { content: 'Repair queue state', status: 'in_progress' },
      { content: 'Verify the composer', status: 'pending' },
    ]);
  });
});

describe('AgentTimelineConversation collapse preferences', () => {
  it('keeps both conversation surfaces collapsed before config loads', () => {
    expect(resolveConversationCollapsePreferences(null)).toEqual({
      collapseAiMessages: true,
      expandFileChanges: false,
    });
  });

  it('honors an explicit opt-out for both preferences', () => {
    expect(
      resolveConversationCollapsePreferences({
        ai_message_default_collapsed: false,
        files_changed_default_collapsed: false,
      })
    ).toEqual({
      collapseAiMessages: false,
      expandFileChanges: true,
    });
  });
});

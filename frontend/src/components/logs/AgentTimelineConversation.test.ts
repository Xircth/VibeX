import { describe, expect, it } from 'vitest';

import type { ConversationTimelineTurn } from '@/features/conversation/conversationStore';
import {
  contextCompactPresentationForRow,
  conversationThreadMaxWidthClass,
  getLatestTimelinePlanEntries,
  isEditableUserTimelineRow,
  isTimelineTurnInFlight,
} from './AgentTimelineConversation';

function row(
  key: string,
  role: 'user' | 'assistant',
  phase: ConversationTimelineTurn['phase']
): ConversationTimelineTurn {
  return {
    key,
    phase,
    revision: 0n,
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

  it('does not treat a settled user with leftover streaming assistant as in-flight', () => {
    expect(
      isTimelineTurnInFlight([
        row('turn-2', 'user', 'settled'),
        row('turn-2', 'assistant', 'streaming'),
      ])
    ).toBe(false);
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

describe('AgentTimelineConversation workspace width', () => {
  it('removes the reading-width cap when the workspace editor area is collapsed', () => {
    expect(conversationThreadMaxWidthClass('workspace', false)).toBe(
      'max-w-none'
    );
  });

  it('keeps the reading-width cap in normal split layouts', () => {
    expect(conversationThreadMaxWidthClass('workspace', true)).toBe(
      'max-w-6xl'
    );
  });

  it('keeps bounded surfaces capped when the workspace editor state is collapsed', () => {
    expect(conversationThreadMaxWidthClass('bounded', false)).toBe('max-w-6xl');
  });
});

describe('AgentTimelineConversation context compaction projection', () => {
  it('pairs a compact prompt with its assistant metrics', () => {
    const user = row('turn-compact-user', 'user', 'settled');
    user.turn.id = 'turn-compact:user';
    user.turn.blocks = [{ type: 'text', text: '/compact' }];
    const assistant = row('turn-compact-assistant', 'assistant', 'settled');
    assistant.turn.id = 'turn-compact:assistant';
    assistant.turn.duration_ms = 1840n;
    assistant.turn.usage = {
      input_tokens: 40000n,
      output_tokens: 300n,
      cache_creation_input_tokens: 0n,
      cache_read_input_tokens: 2000n,
      context_window_max: 200000n,
      cost_amount: null,
      cost_currency: null,
    };

    expect(contextCompactPresentationForRow([user, assistant], 1)).toEqual({
      status: 'success',
      durationMs: 1840,
      contextTokens: 42300,
    });
  });

  it('marks failed, cancelled, and interrupted compact turns as failed', () => {
    const user = row('turn-compact-user', 'user', 'settled');
    user.turn.id = 'turn-compact:user';
    user.turn.blocks = [{ type: 'text', text: '/compact' }];

    for (const phase of ['failed', 'cancelled', 'interrupted'] as const) {
      const assistant = row('turn-compact-assistant', 'assistant', phase);
      assistant.turn.id = 'turn-compact:assistant';
      expect(
        contextCompactPresentationForRow([user, assistant], 1)?.status
      ).toBe('failed');
    }
  });

  it('does not invent metrics for ordinary assistant turns', () => {
    expect(
      contextCompactPresentationForRow(
        [
          row('ordinary-user', 'user', 'settled'),
          row('ordinary-ai', 'assistant', 'settled'),
        ],
        1
      )
    ).toBeNull();
  });
});

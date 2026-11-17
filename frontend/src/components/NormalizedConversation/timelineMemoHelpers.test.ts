import { describe, expect, it } from 'vitest';
import type { ContentBlock, PlanEntry } from 'shared/types';
import type { ConversationTimelineTurn } from '@/features/conversation/conversationStore';
import {
  buildContextCompactPresentationByRowKey,
  getLatestTimelinePlanEntries,
  turnCopyText,
} from './timelineMemoHelpers';

function turnRow(
  id: string,
  role: 'user' | 'assistant',
  blocks: ContentBlock[],
  phase: ConversationTimelineTurn['phase'] = 'settled',
  extra: Partial<ConversationTimelineTurn['turn']> = {}
): ConversationTimelineTurn {
  return {
    key: id,
    phase,
    revision: 1n,
    turn: {
      id,
      role,
      blocks,
      timestamp: '2026-08-24T00:00:00.000Z',
      ...extra,
    },
  };
}

describe('timelineMemoHelpers', () => {
  it('resolves the latest plan block scanning backwards across mixed turns', () => {
    const olderPlan: PlanEntry[] = [
      { content: 'Old step', status: 'completed', priority: 'medium' },
    ];
    const newerPlan: PlanEntry[] = [
      { content: 'Latest step', status: 'in_progress', priority: 'high' },
    ];
    const timeline: ConversationTimelineTurn[] = [
      turnRow('turn-1:assistant', 'assistant', [
        { type: 'plan', entries: olderPlan },
      ]),
      turnRow('turn-2:assistant', 'assistant', [
        {
          type: 'tool_use',
          tool_use_id: 'todo-1',
          tool_name: 'TodoWrite',
          input_preview: JSON.stringify({
            todos: [
              { content: 'Todo step', status: 'pending', priority: 'low' },
            ],
          }),
          meta: null,
        },
        { type: 'plan', entries: newerPlan },
      ]),
      turnRow('turn-3:assistant', 'assistant', [
        { type: 'text', text: 'Done' },
      ]),
    ];

    expect(getLatestTimelinePlanEntries(timeline)).toEqual(newerPlan);
  });

  it('falls back to TodoWrite or acp-plan tool previews when no plan block exists', () => {
    const timeline: ConversationTimelineTurn[] = [
      turnRow('turn-1:assistant', 'assistant', [
        {
          type: 'tool_use',
          tool_use_id: 'acp-plan',
          tool_name: 'Plan',
          input_preview: JSON.stringify({
            todos: [
              {
                content: 'Audit replay',
                status: 'completed',
                priority: 'high',
              },
              { content: 'Run tests', status: 'in_progress' },
            ],
          }),
          meta: null,
        },
      ]),
    ];

    expect(getLatestTimelinePlanEntries(timeline)).toEqual([
      { content: 'Audit replay', status: 'completed', priority: 'high' },
      { content: 'Run tests', status: 'in_progress', priority: null },
    ]);
  });

  it('builds context-compact presentations once per row key including acp-* turns', () => {
    const timeline: ConversationTimelineTurn[] = [
      turnRow('turn-1:user', 'user', [{ type: 'text', text: '/compact' }]),
      turnRow(
        'turn-1:assistant',
        'assistant',
        [{ type: 'text', text: 'Compacted context summary' }],
        'settled',
        {
          duration_ms: 1200n,
          usage: {
            input_tokens: 100n,
            output_tokens: 50n,
            cache_creation_input_tokens: 0n,
            cache_read_input_tokens: 0n,
            context_used: 3200n,
            context_window_max: 200000n,
          },
        }
      ),
      turnRow('turn-2:user', 'user', [
        { type: 'text', text: '/compact focus' },
      ]),
      turnRow(
        'acp-assistant-2',
        'assistant',
        [{ type: 'text', text: 'ACP compacted' }],
        'streaming'
      ),
      turnRow('turn-3:user', 'user', [
        { type: 'text', text: 'Normal question' },
      ]),
      turnRow('turn-3:assistant', 'assistant', [
        { type: 'text', text: 'Normal answer' },
      ]),
    ];

    const byKey = buildContextCompactPresentationByRowKey(timeline);
    expect(byKey.get('turn-1:assistant')).toEqual({
      status: 'success',
      durationMs: 1200,
      contextTokens: 3200,
    });
    expect(byKey.get('acp-assistant-2')).toEqual({
      status: 'running',
      durationMs: null,
      contextTokens: null,
    });
    expect(byKey.get('turn-3:assistant')).toBeNull();
  });

  it('extracts copy text cleanly for 0, 1, and multiple text blocks', () => {
    expect(
      turnCopyText(
        turnRow('t0', 'assistant', [{ type: 'thinking', text: 'x' }]).turn
      )
    ).toBe('');
    expect(
      turnCopyText(
        turnRow('t1', 'assistant', [{ type: 'text', text: '  Single  ' }]).turn
      )
    ).toBe('Single');
    expect(
      turnCopyText(
        turnRow('t2', 'assistant', [
          { type: 'text', text: 'First' },
          { type: 'thinking', text: 'skip' },
          { type: 'text', text: 'Second' },
        ]).turn
      )
    ).toBe('First\n\nSecond');
  });
});

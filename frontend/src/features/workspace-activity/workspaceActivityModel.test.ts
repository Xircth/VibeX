import { describe, expect, it } from 'vitest';
import type { MessageTurn } from 'shared/types';
import { activitySpansFromTurns, spanWindow } from './workspaceActivityModel';

function turn(
  overrides: Partial<MessageTurn> & Pick<MessageTurn, 'id' | 'role'>
): MessageTurn {
  return {
    blocks: [],
    timestamp: '2026-08-31T00:00:00.000Z',
    ...overrides,
  };
}

describe('workspace activity spans', () => {
  it('nests tools and output under an assistant turn', () => {
    const spans = activitySpansFromTurns([
      turn({
        id: 't1:user',
        role: 'user',
        blocks: [{ type: 'text', text: 'start the app' }],
      }),
      turn({
        id: 't1:assistant',
        role: 'assistant',
        duration_ms: 3000n,
        blocks: [
          {
            type: 'tool_use',
            tool_name: 'bash',
            tool_use_id: 'tool-1',
            input_preview: 'pnpm run dev',
            meta: null,
          },
          { type: 'text', text: 'dev server is running' },
        ],
      }),
    ]);

    expect(spans.map((span) => span.kind)).toEqual(['user', 'assistant']);
    expect(spans[1]?.children.map((child) => child.kind)).toEqual([
      'tool',
      'output',
    ]);
    expect(spanWindow(spans).endMs).toBeGreaterThan(spanWindow(spans).startMs);
  });
});

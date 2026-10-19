import { describe, expect, it } from 'vitest';
import type { TurnRenderItem } from '@/components/NormalizedConversation/messageTurnBlocks';
import { assistantBlockSlices } from './assistantVirtualSlices';

function markdown(text: string): TurnRenderItem {
  return { kind: 'markdown', text };
}

function tool(name: string): TurnRenderItem {
  return {
    kind: 'tool',
    use: {
      type: 'tool_use',
      tool_name: name,
      tool_use_id: name,
      input_preview: '{}',
      meta: null,
    },
    result: null,
  };
}

describe('assistantBlockSlices', () => {
  it('virtualizes a streaming tool run as a fold plus the live tail', () => {
    const items = [tool('a'), tool('b'), tool('c'), tool('d'), tool('e')];
    expect(
      assistantBlockSlices({
        items,
        isStreaming: true,
        collapseProcess: true,
        processExpanded: () => false,
      })
    ).toEqual([
      { kind: 'process-fold', count: 3, startIndex: 0 },
      { kind: 'block', itemIndex: 3 },
      { kind: 'block', itemIndex: 4 },
    ]);
  });

  it('inserts one row per block when the process fold is expanded', () => {
    const items = [tool('a'), tool('b'), tool('c'), tool('d')];
    expect(
      assistantBlockSlices({
        items,
        isStreaming: true,
        collapseProcess: true,
        processExpanded: () => true,
      })
    ).toEqual([
      { kind: 'process-fold', count: 2, startIndex: 0 },
      { kind: 'block', itemIndex: 0 },
      { kind: 'block', itemIndex: 1 },
      { kind: 'block', itemIndex: 2 },
      { kind: 'block', itemIndex: 3 },
    ]);
  });

  it('keeps a settled tool run folded into one row', () => {
    const items = [tool('a'), tool('b'), tool('c')];
    expect(
      assistantBlockSlices({
        items,
        isStreaming: false,
        collapseProcess: true,
        processExpanded: () => false,
      })
    ).toEqual([{ kind: 'process-fold', count: 3, startIndex: 0 }]);
  });

  it('keeps the streaming tool fold after earlier prose', () => {
    const items = [
      markdown('answer'),
      tool('a'),
      tool('b'),
      tool('c'),
      tool('d'),
    ];
    expect(
      assistantBlockSlices({
        items,
        isStreaming: true,
        collapseProcess: true,
        processExpanded: () => false,
      })
    ).toEqual([
      { kind: 'block', itemIndex: 0 },
      { kind: 'process-fold', count: 2, startIndex: 1 },
      { kind: 'block', itemIndex: 3 },
      { kind: 'block', itemIndex: 4 },
    ]);
  });
});

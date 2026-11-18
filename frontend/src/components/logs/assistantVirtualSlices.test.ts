import { describe, expect, it } from 'vitest';
import type { TurnRenderItem } from '@/components/NormalizedConversation/messageTurnBlocks';
import {
  assistantBlockSlices,
  buildTimelineVirtualEntries,
  virtualRowFoldEdge,
} from './assistantVirtualSlices';

function markdown(text: string): TurnRenderItem {
  return { kind: 'markdown', text };
}

function thinking(text: string): TurnRenderItem {
  return { kind: 'thinking', text };
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
      { kind: 'block', itemIndex: 0, inExpandedFold: true },
      { kind: 'block', itemIndex: 1, inExpandedFold: true },
      { kind: 'block', itemIndex: 2 },
      { kind: 'block', itemIndex: 3 },
    ]);
  });

  it('keeps the latest settled prose beside one fold of tools and thinking', () => {
    const reply = '无限画布上按住 Ctrl 再滚动，回复仍然在。';
    const items = [
      tool('rg'),
      thinking('looking'),
      markdown('先看缩放。'),
      tool('test'),
      thinking('checking'),
      markdown(reply),
    ];
    expect(
      assistantBlockSlices({
        items,
        isStreaming: false,
        collapseProcess: true,
        processExpanded: () => false,
      })
    ).toEqual([
      { kind: 'process-fold', count: 5, startIndex: 0 },
      { kind: 'block', itemIndex: 5 },
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

  it('leaves tools after the latest prose in the stream', () => {
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
      { kind: 'block', itemIndex: 1 },
      { kind: 'block', itemIndex: 2 },
      { kind: 'block', itemIndex: 3 },
      { kind: 'block', itemIndex: 4 },
    ]);
  });

  it('folds every message before the latest streaming prose into one row', () => {
    const items = [
      markdown('first'),
      tool('a'),
      markdown('second'),
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
      { kind: 'process-fold', count: 2, startIndex: 0 },
      { kind: 'block', itemIndex: 2 },
      { kind: 'block', itemIndex: 3 },
      { kind: 'block', itemIndex: 4 },
      { kind: 'block', itemIndex: 5 },
    ]);
  });
});

describe('buildTimelineVirtualEntries keys', () => {
  const prose = '已经写好的回答，后面继续长也不会换测量 key';

  function entriesFor(blocks: Array<Record<string, unknown>>) {
    return buildTimelineVirtualEntries({
      items: [
        {
          kind: 'message',
          item: {
            key: 'row-1',
            phase: 'streaming',
            turn: {
              id: 'turn-1',
              role: 'assistant',
              blocks,
            },
          },
          row: { row_id: 'row-1' },
        } as never,
      ],
      collapseProcess: false,
      hideThinking: false,
      processExpanded: () => false,
      isContextCompact: () => false,
    });
  }

  it('keeps a prose key when a tool is inserted ahead of it', () => {
    const before = entriesFor([{ type: 'text', text: prose }]);
    const after = entriesFor([
      {
        type: 'tool_use',
        tool_name: 'Read',
        tool_use_id: 'call-9',
        input_preview: '{}',
        meta: null,
      },
      { type: 'text', text: prose },
    ]);
    const proseKey = before.find((entry) => entry.key.includes(':md:'))?.key;
    expect(proseKey).toBeTruthy();
    expect(after.map((entry) => entry.key)).toContain(proseKey);
    expect(after.some((entry) => entry.key.includes('tool:call-9'))).toBe(true);
  });

  it('keeps a prose key while the streamed text grows past the prefix', () => {
    const prefix = 'x'.repeat(64);
    const before = entriesFor([{ type: 'text', text: prefix }]);
    const after = entriesFor([
      { type: 'text', text: `${prefix} and then a much longer answer` },
    ]);
    expect(before[0]?.key).toBe(after[0]?.key);
  });
});

describe('virtualRowFoldEdge', () => {
  it('marks only the boundary between an expanded fold and the following prose', () => {
    const entries = buildTimelineVirtualEntries({
      items: [
        {
          kind: 'message',
          item: {
            key: 'row-1',
            phase: 'settled',
            turn: {
              id: 'turn-1',
              role: 'assistant',
              blocks: [
                { type: 'thinking', text: 'note' },
                { type: 'text', text: 'inside' },
                { type: 'text', text: 'outside' },
              ],
            },
          },
          row: { row_id: 'row-1' },
        } as never,
      ],
      collapseProcess: true,
      hideThinking: false,
      processExpanded: () => true,
      isContextCompact: () => false,
    });

    expect(entries.map((entry) => entry.slice)).toEqual([
      { kind: 'process-fold', count: 2, startIndex: 0 },
      { kind: 'block', itemIndex: 0, inExpandedFold: true },
      { kind: 'block', itemIndex: 1, inExpandedFold: true },
      { kind: 'block', itemIndex: 2 },
    ]);
    expect(
      entries.map((_, index) => virtualRowFoldEdge(entries, index))
    ).toEqual([null, null, 'tail', 'after']);
  });

  it('preserves exact itemIndex across multi-segment folds using Map lookup', () => {
    const items: TurnRenderItem[] = [
      ...Array.from({ length: 40 }, (_, i) => tool(`t-${i}`)),
      markdown('middle prose'),
      ...Array.from({ length: 15 }, (_, i) => tool(`tail-${i}`)),
      markdown('final prose'),
    ];
    const slices = assistantBlockSlices({
      items,
      isStreaming: false,
      collapseProcess: true,
      processExpanded: () => true,
    });
    const blockIndices = slices
      .filter(
        (s): s is Extract<typeof s, { kind: 'block' }> => s.kind === 'block'
      )
      .map((s) => s.itemIndex);
    expect(blockIndices).toEqual(items.map((_, index) => index));
  });
});

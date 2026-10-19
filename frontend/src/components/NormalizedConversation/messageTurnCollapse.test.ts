import { describe, expect, it } from 'vitest';
import type { TurnRenderItem } from './messageTurnBlocks';
import { collapseTurnSegments } from './messageTurnCollapse';

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

describe('collapseTurnSegments', () => {
  it('keeps the last assistant markdown outside the collapsed prelude', () => {
    const items = [
      tool('bash'),
      markdown('working'),
      tool('read'),
      markdown('done'),
    ];

    expect(collapseTurnSegments(items)).toEqual([
      {
        kind: 'fold',
        startIndex: 0,
        items: [tool('bash'), markdown('working'), tool('read')],
      },
      { kind: 'items', startIndex: 3, items: [markdown('done')] },
    ]);
  });

  it('does not copy the visible markdown into the collapsed prelude', () => {
    const items = [
      tool('bash'),
      markdown('项目已启动完成。'),
      tool('read'),
      markdown('项目已启动完成。'),
    ];

    const segments = collapseTurnSegments(items);
    expect(segments.at(-1)).toEqual({
      kind: 'items',
      startIndex: 3,
      items: [markdown('项目已启动完成。')],
    });
    expect(
      segments
        .flatMap((segment) => segment.items)
        .filter(
          (item) => item.kind === 'markdown' && item.text === '项目已启动完成。'
        )
    ).toEqual([markdown('项目已启动完成。')]);
  });

  it('keeps tool-only items visible while streaming and folds them once markdown arrives', () => {
    const toolOnly = [tool('bash'), tool('read')];
    expect(collapseTurnSegments(toolOnly, { isStreaming: true })).toEqual([
      { kind: 'items', startIndex: 0, items: toolOnly },
    ]);
    expect(collapseTurnSegments(toolOnly, { isStreaming: false })).toEqual([
      { kind: 'fold', startIndex: 0, items: toolOnly },
    ]);

    const withFirstMarkdown = [...toolOnly, markdown('first stage')];
    expect(
      collapseTurnSegments(withFirstMarkdown, { isStreaming: true })
    ).toEqual([{ kind: 'items', startIndex: 0, items: withFirstMarkdown }]);

    const withMoreTools = [...withFirstMarkdown, tool('grep')];
    expect(collapseTurnSegments(withMoreTools, { isStreaming: true })).toEqual([
      { kind: 'fold', startIndex: 0, items: [tool('bash')] },
      {
        kind: 'items',
        startIndex: 1,
        items: [tool('read'), markdown('first stage'), tool('grep')],
      },
    ]);

    const withSecondMarkdown = [...withMoreTools, markdown('second stage')];
    const second = collapseTurnSegments(withSecondMarkdown, {
      isStreaming: true,
    });
    expect(second.flatMap((segment) => segment.items)).toEqual(
      expect.arrayContaining([
        markdown('first stage'),
        markdown('second stage'),
      ])
    );
    expect(
      second.some(
        (segment) =>
          segment.kind === 'fold' &&
          segment.items.some(
            (item) => item.kind === 'markdown' && item.text === 'first stage'
          )
      )
    ).toBe(false);
  });

  it('keeps earlier distinct markdown visible while a later stream continues', () => {
    const items = [
      tool('bash'),
      tool('ls'),
      markdown('already on screen'),
      tool('read'),
      markdown('new stream'),
    ];
    expect(collapseTurnSegments(items, { isStreaming: true })).toEqual([
      { kind: 'fold', startIndex: 0, items: [tool('bash')] },
      {
        kind: 'items',
        startIndex: 1,
        items: [
          tool('ls'),
          markdown('already on screen'),
          tool('read'),
          markdown('new stream'),
        ],
      },
    ]);
  });

  it('folds a streaming tool run down to a two-block tail', () => {
    const tools = [tool('bash'), tool('read'), tool('grep'), tool('edit')];
    expect(collapseTurnSegments(tools, { isStreaming: true })).toEqual([
      {
        kind: 'fold',
        startIndex: 0,
        items: [tool('bash'), tool('read')],
      },
      { kind: 'items', startIndex: 2, items: [tool('grep'), tool('edit')] },
    ]);
  });

  it('keeps earlier prose before the streaming tool fold', () => {
    const items = [
      markdown('answer'),
      tool('read'),
      tool('grep'),
      tool('edit'),
      tool('write'),
    ];
    expect(collapseTurnSegments(items, { isStreaming: true })).toEqual([
      { kind: 'items', startIndex: 0, items: [markdown('answer')] },
      { kind: 'fold', startIndex: 1, items: [tool('read'), tool('grep')] },
      { kind: 'items', startIndex: 3, items: [tool('edit'), tool('write')] },
    ]);
  });

  it('keeps a leading tool fold, then prose, then later tools in document order', () => {
    const items = [
      tool('bash'),
      markdown('answer'),
      tool('read'),
      tool('grep'),
      tool('edit'),
      tool('write'),
    ];
    expect(collapseTurnSegments(items, { isStreaming: true })).toEqual([
      { kind: 'fold', startIndex: 0, items: [tool('bash')] },
      { kind: 'items', startIndex: 1, items: [markdown('answer')] },
      { kind: 'fold', startIndex: 2, items: [tool('read'), tool('grep')] },
      { kind: 'items', startIndex: 4, items: [tool('edit'), tool('write')] },
    ]);
  });
});

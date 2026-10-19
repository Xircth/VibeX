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

  it('folds every message before each new prose, including earlier prose', () => {
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
    ).toEqual([
      { kind: 'fold', startIndex: 0, items: toolOnly },
      { kind: 'items', startIndex: 2, items: [markdown('first stage')] },
    ]);

    const withMoreTools = [...withFirstMarkdown, tool('grep')];
    expect(collapseTurnSegments(withMoreTools, { isStreaming: true })).toEqual([
      { kind: 'fold', startIndex: 0, items: [tool('bash'), tool('read')] },
      {
        kind: 'items',
        startIndex: 2,
        items: [markdown('first stage'), tool('grep')],
      },
    ]);

    const withSecondMarkdown = [...withMoreTools, markdown('second stage')];
    expect(
      collapseTurnSegments(withSecondMarkdown, { isStreaming: true })
    ).toEqual([
      {
        kind: 'fold',
        startIndex: 0,
        items: [
          tool('bash'),
          tool('read'),
          markdown('first stage'),
          tool('grep'),
        ],
      },
      { kind: 'items', startIndex: 4, items: [markdown('second stage')] },
    ]);
  });

  it('folds everything before the latest prose while streaming continues', () => {
    const items = [
      tool('bash'),
      tool('ls'),
      markdown('already on screen'),
      tool('read'),
      markdown('new stream'),
    ];
    expect(collapseTurnSegments(items, { isStreaming: true })).toEqual([
      {
        kind: 'fold',
        startIndex: 0,
        items: [
          tool('bash'),
          tool('ls'),
          markdown('already on screen'),
          tool('read'),
        ],
      },
      { kind: 'items', startIndex: 4, items: [markdown('new stream')] },
    ]);
  });

  it('omits an earlier copy of the visible prose from the streaming fold', () => {
    const items = [
      tool('bash'),
      markdown('项目已启动完成。'),
      tool('read'),
      markdown('项目已启动完成。'),
    ];
    const segments = collapseTurnSegments(items, { isStreaming: true });
    expect(segments).toEqual([
      {
        kind: 'fold',
        startIndex: 0,
        items: [tool('bash'), tool('read')],
      },
      { kind: 'items', startIndex: 3, items: [markdown('项目已启动完成。')] },
    ]);
    expect(
      segments
        .flatMap((segment) => segment.items)
        .filter(
          (item) => item.kind === 'markdown' && item.text === '项目已启动完成。'
        )
    ).toEqual([markdown('项目已启动完成。')]);
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

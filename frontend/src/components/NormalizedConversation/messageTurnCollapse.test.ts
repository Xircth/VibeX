import { describe, expect, it } from 'vitest';
import type { TurnRenderItem } from './messageTurnBlocks';
import { splitCollapsedTurnItems } from './messageTurnCollapse';

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

describe('splitCollapsedTurnItems', () => {
  it('keeps the last assistant markdown outside the collapsed prelude', () => {
    const items = [
      tool('bash'),
      markdown('working'),
      tool('read'),
      markdown('done'),
    ];

    expect(splitCollapsedTurnItems(items)).toEqual({
      prelude: [tool('bash'), markdown('working'), tool('read')],
      rest: [markdown('done')],
    });
  });

  it('does not copy the visible markdown into the collapsed prelude', () => {
    const items = [
      tool('bash'),
      markdown('项目已启动完成。'),
      tool('read'),
      markdown('项目已启动完成。'),
    ];

    const split = splitCollapsedTurnItems(items);
    expect(split.rest).toEqual([markdown('项目已启动完成。')]);
    expect(
      split.prelude.filter(
        (item) => item.kind === 'markdown' && item.text === '项目已启动完成。'
      )
    ).toEqual([]);
  });

  it('keeps tool-only items in rest while streaming and folds them once markdown arrives', () => {
    const toolOnly = [tool('bash'), tool('read')];
    expect(splitCollapsedTurnItems(toolOnly, { isStreaming: true })).toEqual({
      prelude: [],
      rest: toolOnly,
    });
    expect(splitCollapsedTurnItems(toolOnly, { isStreaming: false })).toEqual({
      prelude: toolOnly,
      rest: [],
    });

    const withFirstMarkdown = [...toolOnly, markdown('first stage')];
    expect(
      splitCollapsedTurnItems(withFirstMarkdown, { isStreaming: true })
    ).toEqual({
      prelude: toolOnly,
      rest: [markdown('first stage')],
    });

    const withMoreTools = [...withFirstMarkdown, tool('grep')];
    expect(
      splitCollapsedTurnItems(withMoreTools, { isStreaming: true })
    ).toEqual({
      prelude: toolOnly,
      rest: [markdown('first stage'), tool('grep')],
    });

    const withSecondMarkdown = [...withMoreTools, markdown('second stage')];
    expect(
      splitCollapsedTurnItems(withSecondMarkdown, { isStreaming: true })
    ).toEqual({
      prelude: [...toolOnly, markdown('first stage'), tool('grep')],
      rest: [markdown('second stage')],
    });
  });

  it('folds a streaming tool run down to a two-block tail', () => {
    const tools = [tool('bash'), tool('read'), tool('grep'), tool('edit')];
    expect(splitCollapsedTurnItems(tools, { isStreaming: true })).toEqual({
      prelude: [tool('bash'), tool('read')],
      rest: [tool('grep'), tool('edit')],
    });
  });

  it('keeps the last markdown and only the last two following tools while streaming', () => {
    const items = [
      tool('bash'),
      markdown('answer'),
      tool('read'),
      tool('grep'),
      tool('edit'),
      tool('write'),
    ];
    expect(splitCollapsedTurnItems(items, { isStreaming: true })).toEqual({
      prelude: [tool('bash'), tool('read'), tool('grep')],
      rest: [markdown('answer'), tool('edit'), tool('write')],
    });
  });
});

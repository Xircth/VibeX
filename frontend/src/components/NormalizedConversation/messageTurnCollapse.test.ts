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
});

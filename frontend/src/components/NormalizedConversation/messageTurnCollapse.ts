import type { TurnRenderItem } from './messageTurnBlocks';

export function splitCollapsedTurnItems(items: TurnRenderItem[]): {
  prelude: TurnRenderItem[];
  rest: TurnRenderItem[];
} {
  const lastMarkdownIndex = items.reduce(
    (acc, item, index) => (item.kind === 'markdown' ? index : acc),
    -1
  );

  if (lastMarkdownIndex < 0) {
    return { prelude: items, rest: [] };
  }

  const visible = items[lastMarkdownIndex];
  const visibleText = visible?.kind === 'markdown' ? visible.text.trim() : '';
  const prelude = items.slice(0, lastMarkdownIndex).filter((item) => {
    if (item.kind !== 'markdown' || visibleText.length === 0) {
      return true;
    }
    return item.text.trim() !== visibleText;
  });

  return {
    prelude,
    rest: items.slice(lastMarkdownIndex),
  };
}

import type { TurnRenderItem } from './messageTurnBlocks';

/** Blocks kept mounted while a turn is still streaming. The rest stay folded. */
export const STREAMING_VISIBLE_TAIL = 2;

export function isCollapsibleProcessItem(item: TurnRenderItem): boolean {
  return item.kind !== 'markdown' || item.text.trim().length > 0;
}

export function splitCollapsedTurnItems(
  items: TurnRenderItem[],
  options?: { isStreaming?: boolean }
): {
  prelude: TurnRenderItem[];
  rest: TurnRenderItem[];
} {
  const lastMarkdownIndex = items.reduce(
    (acc, item, index) => (item.kind === 'markdown' ? index : acc),
    -1
  );

  if (lastMarkdownIndex < 0) {
    if (!options?.isStreaming) {
      return { prelude: items, rest: [] };
    }
    return streamingTail(items, -1);
  }

  if (options?.isStreaming) {
    return streamingTail(items, lastMarkdownIndex);
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

function streamingTail(
  items: TurnRenderItem[],
  lastMarkdownIndex: number
): { prelude: TurnRenderItem[]; rest: TurnRenderItem[] } {
  if (lastMarkdownIndex < 0) {
    if (items.length <= STREAMING_VISIBLE_TAIL) {
      return { prelude: [], rest: items };
    }
    const splitAt = items.length - STREAMING_VISIBLE_TAIL;
    return {
      prelude: items.slice(0, splitAt),
      rest: items.slice(splitAt),
    };
  }

  const visible = items[lastMarkdownIndex];
  const visibleText = visible?.kind === 'markdown' ? visible.text.trim() : '';
  const before = items.slice(0, lastMarkdownIndex).filter((item) => {
    if (item.kind !== 'markdown' || visibleText.length === 0) {
      return true;
    }
    return item.text.trim() !== visibleText;
  });
  const after = items.slice(lastMarkdownIndex + 1);
  const keptAfter =
    after.length > STREAMING_VISIBLE_TAIL
      ? after.slice(after.length - STREAMING_VISIBLE_TAIL)
      : after;
  const overflowAfter = after.slice(0, after.length - keptAfter.length);
  return {
    prelude: [...before, ...overflowAfter],
    rest: visible ? [visible, ...keptAfter] : keptAfter,
  };
}

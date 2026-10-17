import type { TurnRenderItem } from './messageTurnBlocks';

/** Process cards kept mounted while a turn is still streaming. Markdown stays. */
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
  if (options?.isStreaming) {
    return streamingTail(items);
  }

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

function streamingTail(items: TurnRenderItem[]): {
  prelude: TurnRenderItem[];
  rest: TurnRenderItem[];
} {
  const lastMarkdown = [...items]
    .reverse()
    .find((item) => item.kind === 'markdown');
  const lastText =
    lastMarkdown?.kind === 'markdown' ? lastMarkdown.text.trim() : '';
  const processIndices: number[] = [];
  items.forEach((item, index) => {
    if (item.kind !== 'markdown') processIndices.push(index);
  });
  const visibleProcess = new Set(processIndices.slice(-STREAMING_VISIBLE_TAIL));
  const prelude: TurnRenderItem[] = [];
  const rest: TurnRenderItem[] = [];
  items.forEach((item, index) => {
    if (item.kind === 'markdown') {
      if (
        item !== lastMarkdown &&
        lastText.length > 0 &&
        item.text.trim() === lastText
      ) {
        return;
      }
      rest.push(item);
      return;
    }
    if (visibleProcess.has(index)) rest.push(item);
    else prelude.push(item);
  });
  return { prelude, rest };
}

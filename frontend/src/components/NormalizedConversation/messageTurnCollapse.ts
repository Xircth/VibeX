import type { TurnRenderItem } from './messageTurnBlocks';

/** Process cards kept mounted while a turn is still streaming. Markdown stays. */
export const STREAMING_VISIBLE_TAIL = 2;

export type CollapsedTurnSegment = {
  kind: 'fold' | 'items';
  startIndex: number;
  items: TurnRenderItem[];
};

export function isCollapsibleProcessItem(item: TurnRenderItem): boolean {
  return item.kind !== 'markdown' || item.text.trim().length > 0;
}

export function collapseTurnSegments(
  items: TurnRenderItem[],
  options?: { isStreaming?: boolean }
): CollapsedTurnSegment[] {
  return options?.isStreaming
    ? streamingSegments(items)
    : settledSegments(items);
}

function settledSegments(items: TurnRenderItem[]): CollapsedTurnSegment[] {
  const lastMarkdownIndex = items.reduce(
    (acc, item, index) => (item.kind === 'markdown' ? index : acc),
    -1
  );

  if (lastMarkdownIndex < 0) {
    if (items.length === 0) return [];
    return [{ kind: 'fold', startIndex: 0, items: [...items] }];
  }

  const visible = items[lastMarkdownIndex];
  const visibleText = visible?.kind === 'markdown' ? visible.text.trim() : '';
  const prelude = items.slice(0, lastMarkdownIndex).filter((item) => {
    if (item.kind !== 'markdown' || visibleText.length === 0) {
      return true;
    }
    return item.text.trim() !== visibleText;
  });

  const segments: CollapsedTurnSegment[] = [];
  if (prelude.length > 0) {
    const preludeStart = items.indexOf(prelude[0]);
    segments.push({
      kind: prelude.some(isCollapsibleProcessItem) ? 'fold' : 'items',
      startIndex: preludeStart < 0 ? 0 : preludeStart,
      items: prelude,
    });
  }
  segments.push({
    kind: 'items',
    startIndex: lastMarkdownIndex,
    items: items.slice(lastMarkdownIndex),
  });
  return segments;
}

function streamingSegments(items: TurnRenderItem[]): CollapsedTurnSegment[] {
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
  const segments: CollapsedTurnSegment[] = [];

  items.forEach((item, index) => {
    if (
      item.kind === 'markdown' &&
      item !== lastMarkdown &&
      lastText.length > 0 &&
      item.text.trim() === lastText
    ) {
      return;
    }
    const kind: CollapsedTurnSegment['kind'] =
      item.kind === 'markdown' || visibleProcess.has(index) ? 'items' : 'fold';
    const current = segments.at(-1);
    if (current?.kind === kind) {
      current.items.push(item);
      return;
    }
    segments.push({ kind, startIndex: index, items: [item] });
  });
  return segments;
}

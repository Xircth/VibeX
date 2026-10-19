import type { TurnRenderItem } from './messageTurnBlocks';

/**
 * Live cards kept mounted after the latest prose, or during a tool-only stream.
 * Earlier prose is folded with everything that preceded the latest prose.
 */
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
  if (items.length === 0) return [];
  const lastMarkdownIndex = items.reduce(
    (latest, item, index) => (item.kind === 'markdown' ? index : latest),
    -1
  );
  if (lastMarkdownIndex < 0) {
    return options?.isStreaming
      ? liveTail(items, 0)
      : [{ kind: 'fold', startIndex: 0, items: [...items] }];
  }
  const segments = foldBeforeProse(items, lastMarkdownIndex);
  if (!options?.isStreaming) return segments;
  return splitLiveSuffix(segments, lastMarkdownIndex);
}

/** One prelude of everything before the latest prose, then that prose onward. */
function foldBeforeProse(
  items: TurnRenderItem[],
  lastMarkdownIndex: number
): CollapsedTurnSegment[] {
  const visible = items[lastMarkdownIndex];
  const visibleText = visible?.kind === 'markdown' ? visible.text.trim() : '';
  const prelude = items.slice(0, lastMarkdownIndex).filter((item) => {
    if (item.kind !== 'markdown' || visibleText.length === 0) return true;
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

/** Keep only the newest live cards after the prose that just closed the prelude. */
function splitLiveSuffix(
  segments: CollapsedTurnSegment[],
  lastMarkdownIndex: number
): CollapsedTurnSegment[] {
  const visible = segments.at(-1);
  if (!visible || visible.kind !== 'items') return segments;
  const suffix = visible.items.slice(1);
  if (suffix.length <= STREAMING_VISIBLE_TAIL) return segments;
  const hiddenCount = suffix.length - STREAMING_VISIBLE_TAIL;
  const foldStart = lastMarkdownIndex + 1;
  return [
    ...segments.slice(0, -1),
    {
      kind: 'items',
      startIndex: lastMarkdownIndex,
      items: visible.items.slice(0, 1),
    },
    {
      kind: 'fold',
      startIndex: foldStart,
      items: suffix.slice(0, hiddenCount),
    },
    {
      kind: 'items',
      startIndex: foldStart + hiddenCount,
      items: suffix.slice(hiddenCount),
    },
  ];
}

function liveTail(
  items: TurnRenderItem[],
  startIndex: number
): CollapsedTurnSegment[] {
  if (items.length <= STREAMING_VISIBLE_TAIL) {
    return [{ kind: 'items', startIndex, items: [...items] }];
  }
  const hiddenCount = items.length - STREAMING_VISIBLE_TAIL;
  return [
    {
      kind: 'fold',
      startIndex,
      items: items.slice(0, hiddenCount),
    },
    {
      kind: 'items',
      startIndex: startIndex + hiddenCount,
      items: items.slice(hiddenCount),
    },
  ];
}

import type { ConversationTimelineItem } from '@/features/conversation/conversationStore';
import {
  planTurnBlocks,
  type TurnRenderItem,
} from '@/components/NormalizedConversation/messageTurnBlocks';
import {
  collapseTurnSegments,
  isCollapsibleProcessItem,
} from '@/components/NormalizedConversation/messageTurnCollapse';

const STREAMING_TEXT_PREFIX = 64;

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Identity that stays put while a streaming block grows or shifts index. */
export function blockVirtualKey(item: TurnRenderItem): string {
  switch (item.kind) {
    case 'tool': {
      const id = item.use?.tool_use_id ?? item.result?.tool_use_id;
      if (id) return `tool:${id}`;
      const name = item.use?.tool_name ?? item.result?.tool_name ?? 'tool';
      return `tool-name:${name}`;
    }
    case 'markdown':
      return `md:${fnv1a(item.text.slice(0, STREAMING_TEXT_PREFIX))}`;
    case 'thinking':
      return `think:${fnv1a(item.text.slice(0, STREAMING_TEXT_PREFIX))}`;
    case 'image':
      return `img:${item.uri ?? fnv1a(item.data.slice(0, STREAMING_TEXT_PREFIX))}`;
    case 'image_generation':
      return `igen:${fnv1a(item.revisedPrompt ?? '')}`;
    case 'plan':
      return 'plan';
    case 'resource':
      return `res:${item.uri}`;
    case 'protocol':
      return `proto:${item.label}`;
    default: {
      const _exhaustive: never = item;
      return `block:${String(_exhaustive)}`;
    }
  }
}

export function uniqueBlockVirtualKeys(items: TurnRenderItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((item) => {
    const base = blockVirtualKey(item);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}#${count}`;
  });
}

export type AssistantBlockSlice =
  | { kind: 'process-fold'; count: number; startIndex: number }
  | { kind: 'block'; itemIndex: number; inExpandedFold?: boolean }
  | { kind: 'status' };

export type TimelineVirtualEntry = {
  key: string;
  timelineIndex: number;
  slice: AssistantBlockSlice | null;
  isLast: boolean;
};

export function assistantBlockSlices(input: {
  items: TurnRenderItem[];
  isStreaming: boolean;
  collapseProcess: boolean;
  processExpanded: (foldStartIndex: number) => boolean;
}): AssistantBlockSlice[] {
  if (!input.collapseProcess) {
    if (input.items.length === 0) {
      return input.isStreaming ? [{ kind: 'status' }] : [];
    }
    return input.items.map((_, itemIndex) => ({ kind: 'block', itemIndex }));
  }

  const itemIndexByRef = new Map<TurnRenderItem, number>(
    input.items.map((item, idx) => [item, idx])
  );
  const slices: AssistantBlockSlice[] = [];
  for (const segment of collapseTurnSegments(input.items, {
    isStreaming: input.isStreaming,
  })) {
    if (segment.kind === 'fold') {
      const processCount = segment.items.filter(
        isCollapsibleProcessItem
      ).length;
      if (processCount === 0) continue;
      slices.push({
        kind: 'process-fold',
        count: processCount,
        startIndex: segment.startIndex,
      });
      if (!input.processExpanded(segment.startIndex)) continue;
    }
    const inExpandedFold = segment.kind === 'fold';
    for (const item of segment.items) {
      const itemIndex = itemIndexByRef.get(item) ?? -1;
      if (itemIndex < 0) continue;
      slices.push(
        inExpandedFold
          ? { kind: 'block', itemIndex, inExpandedFold: true }
          : { kind: 'block', itemIndex }
      );
    }
  }
  if (slices.length === 0 && input.isStreaming) {
    slices.push({ kind: 'status' });
  }
  return slices;
}

export function buildTimelineVirtualEntries(input: {
  items: ConversationTimelineItem[];
  collapseProcess: boolean;
  hideThinking: boolean;
  processExpanded: (turnId: string, foldStartIndex: number) => boolean;
  isContextCompact: (rowKey: string) => boolean;
}): TimelineVirtualEntry[] {
  const entries: TimelineVirtualEntry[] = [];
  input.items.forEach((item, timelineIndex) => {
    if (item.kind !== 'message' || item.item.turn.role !== 'assistant') {
      entries.push({
        key:
          item.kind === 'message'
            ? `turn:${item.item.key}`
            : `side:${item.row.row_id}`,
        timelineIndex,
        slice: null,
        isLast: true,
      });
      return;
    }

    const row = item.item;
    if (input.isContextCompact(row.key)) {
      entries.push({
        key: `turn:${row.key}`,
        timelineIndex,
        slice: null,
        isLast: true,
      });
      return;
    }

    const planned = planTurnBlocks(row.turn.blocks);
    const blocks = input.hideThinking
      ? planned.filter((block) => block.kind !== 'thinking')
      : planned;
    const slices = assistantBlockSlices({
      items: blocks,
      isStreaming: row.phase === 'streaming',
      collapseProcess: input.collapseProcess,
      processExpanded: (foldStartIndex) =>
        input.processExpanded(row.turn.id, foldStartIndex),
    });
    if (slices.length === 0) {
      entries.push({
        key: `turn:${row.key}`,
        timelineIndex,
        slice: null,
        isLast: true,
      });
      return;
    }
    const blockKeys = uniqueBlockVirtualKeys(blocks);
    slices.forEach((slice, sliceIndex) => {
      const suffix =
        slice.kind === 'process-fold'
          ? `fold:${blockKeys[slice.startIndex] ?? slice.startIndex}`
          : slice.kind === 'status'
            ? 'status'
            : (blockKeys[slice.itemIndex] ?? `b:${slice.itemIndex}`);
      entries.push({
        key: `turn:${row.key}:${suffix}`,
        timelineIndex,
        slice,
        isLast: sliceIndex === slices.length - 1,
      });
    });
  });
  return entries;
}

/** Row edge where an expanded fold meets the prose that follows it. */
export function virtualRowFoldEdge(
  entries: TimelineVirtualEntry[],
  index: number
): 'tail' | 'after' | null {
  const entry = entries[index];
  if (!entry?.slice) return null;
  const sameTurn = (other: TimelineVirtualEntry | undefined) =>
    other?.timelineIndex === entry.timelineIndex;
  const inFold = (slice: AssistantBlockSlice | null | undefined) =>
    slice?.kind === 'block' && slice.inExpandedFold === true;
  const previous = entries[index - 1];
  const next = entries[index + 1];
  if (
    inFold(entry.slice) &&
    sameTurn(next) &&
    next?.slice != null &&
    !inFold(next.slice)
  ) {
    return 'tail';
  }
  if (!inFold(entry.slice) && sameTurn(previous) && inFold(previous?.slice)) {
    return 'after';
  }
  return null;
}

import type { ConversationTimelineItem } from '@/features/conversation/conversationStore';
import {
  planTurnBlocks,
  type TurnRenderItem,
} from '@/components/NormalizedConversation/messageTurnBlocks';
import {
  isCollapsibleProcessItem,
  splitCollapsedTurnItems,
} from '@/components/NormalizedConversation/messageTurnCollapse';

export type AssistantBlockSlice =
  | { kind: 'process-fold'; count: number }
  | { kind: 'block'; itemIndex: number }
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
  processExpanded: boolean;
}): AssistantBlockSlice[] {
  if (!input.collapseProcess) {
    if (input.items.length === 0) {
      return input.isStreaming ? [{ kind: 'status' }] : [];
    }
    return input.items.map((_, itemIndex) => ({ kind: 'block', itemIndex }));
  }

  const { prelude, rest } = splitCollapsedTurnItems(input.items, {
    isStreaming: input.isStreaming,
  });
  const slices: AssistantBlockSlice[] = [];
  const processCount = prelude.filter(isCollapsibleProcessItem).length;
  if (processCount > 0) {
    slices.push({ kind: 'process-fold', count: processCount });
    if (input.processExpanded) {
      for (const item of prelude) {
        const itemIndex = input.items.indexOf(item);
        if (itemIndex >= 0) slices.push({ kind: 'block', itemIndex });
      }
    }
  }
  for (const item of rest) {
    const itemIndex = input.items.indexOf(item);
    if (itemIndex >= 0) slices.push({ kind: 'block', itemIndex });
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
  processExpanded: (turnId: string) => boolean;
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
      processExpanded: input.processExpanded(row.turn.id),
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
    slices.forEach((slice, sliceIndex) => {
      const suffix =
        slice.kind === 'process-fold'
          ? 'fold'
          : slice.kind === 'status'
            ? 'status'
            : `b:${slice.itemIndex}`;
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

import type { TurnRenderItem } from './messageTurnBlocks';

/**
 * Groups every uninterrupted run of tool calls into one aggregate. A run may
 * mix commands, reads, edits, searches, and arbitrary tools; prose or other
 * message content ends it. Runs of one deliberately remain groups so the
 * conversation has one consistent tool-call disclosure model. VibeX-authored.
 */

export type TurnToolItem = Extract<TurnRenderItem, { kind: 'tool' }>;

export type IndexedTurnItem = { item: TurnRenderItem; index: number };

export type TurnRenderUnit =
  | { kind: 'single'; item: TurnRenderItem; index: number }
  | {
      kind: 'tool_group';
      items: IndexedTurnItem[];
    };

function isToolCall(item: TurnRenderItem): item is TurnToolItem {
  return item.kind === 'tool' && item.use != null;
}

/** Fold every consecutive run of recognized tool calls into a group. */
export function groupTurnRenderItems(
  items: TurnRenderItem[]
): TurnRenderUnit[] {
  const units: TurnRenderUnit[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (!isToolCall(item)) {
      units.push({ kind: 'single', item, index: i });
      i += 1;
      continue;
    }

    const group: IndexedTurnItem[] = [{ item, index: i }];
    let j = i + 1;
    while (j < items.length) {
      const next = items[j];
      if (!isToolCall(next)) break;
      group.push({ item: next, index: j });
      j += 1;
    }

    units.push({
      kind: 'tool_group',
      items: group,
    });
    i = j;
  }
  return units;
}

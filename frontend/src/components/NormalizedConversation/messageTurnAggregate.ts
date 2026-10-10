import type { TurnRenderItem } from './messageTurnBlocks';

export type TurnToolItem = Extract<TurnRenderItem, { kind: 'tool' }>;

export type IndexedTurnItem = { item: TurnRenderItem; index: number };

export type TurnRenderUnit =
  | { kind: 'single'; item: TurnRenderItem; index: number }
  | {
      kind: 'activity_group';
      items: IndexedTurnItem[];
      endIndex: number;
    };

function isToolCall(item: TurnRenderItem): item is TurnToolItem {
  return item.kind === 'tool' && item.use != null;
}

function isActivity(item: TurnRenderItem): boolean {
  return item.kind === 'thinking' || isToolCall(item);
}

/** Prose and other output end a stage; thinking belongs to the tool activity. */
export function groupTurnRenderItems(
  items: TurnRenderItem[]
): TurnRenderUnit[] {
  const units: TurnRenderUnit[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (!isActivity(item)) {
      units.push({ kind: 'single', item, index: i });
      i += 1;
      continue;
    }

    const group: IndexedTurnItem[] = [{ item, index: i }];
    let j = i + 1;
    while (j < items.length) {
      const next = items[j];
      if (!isActivity(next)) break;
      group.push({ item: next, index: j });
      j += 1;
    }

    units.push({
      kind: 'activity_group',
      items: group,
      endIndex: j - 1,
    });
    i = j;
  }
  return units;
}

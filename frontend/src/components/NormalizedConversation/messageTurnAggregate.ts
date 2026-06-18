import {
  AGGREGATABLE_ACTIONS,
  type AggregationType,
} from './conversation-entry-utils';
import type { TurnRenderItem } from './messageTurnBlocks';
import { toolBlockToNormalizedEntry } from './messageTurnTool';

/**
 * Groups a turn's render items so consecutive tool calls of the same kind fold
 * into one "终端 N"-style card, matching the early conversation style. Pure and
 * unit-testable; the rendering of a group lives in MessageTurnView. The keying
 * mirrors `getAggregationKey` in conversation-entry-utils (command/task by
 * action; everything else by action + tool name). VibeX-authored.
 */

export type TurnToolItem = Extract<TurnRenderItem, { kind: 'tool' }>;

/** Aggregatable categories plus the generic-tool bucket (no AGGREGATION_LABELS entry). */
export type TurnAggregationType = AggregationType | 'tool';

export type IndexedTurnItem = { item: TurnRenderItem; index: number };

export type TurnRenderUnit =
  | { kind: 'single'; item: TurnRenderItem; index: number }
  | {
      kind: 'tool_group';
      aggregationType: TurnAggregationType;
      items: IndexedTurnItem[];
    };

/** Aggregation type + run key for a tool item, or null when not aggregatable. */
export function toolAggregation(
  item: TurnToolItem
): { type: TurnAggregationType; key: string } | null {
  if (!item.use) return null;
  const entry = toolBlockToNormalizedEntry(item.use, item.result, null);
  if (entry.entry_type.type !== 'tool_use') return null;
  const action = entry.entry_type.action_type.action;
  // Consecutive generic tool calls fold into one "工具调用 N" group.
  if (action === 'tool') return { type: 'tool', key: 'tool' };
  if (!AGGREGATABLE_ACTIONS.has(action)) return null;
  const type = action as AggregationType;
  // Commands/sub-agents aggregate by action alone; reads/searches/fetches also
  // key on the tool name so different tools don't merge into one group.
  const key =
    type === 'command_run' || type === 'task_create'
      ? type
      : `${type}:${entry.entry_type.tool_name.trim().toLowerCase()}`;
  return { type, key };
}

/** Fold consecutive same-kind aggregatable tools into groups; runs of 1 stay flat. */
export function groupTurnRenderItems(
  items: TurnRenderItem[]
): TurnRenderUnit[] {
  const units: TurnRenderUnit[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    const agg = item.kind === 'tool' ? toolAggregation(item) : null;
    if (!agg) {
      units.push({ kind: 'single', item, index: i });
      i += 1;
      continue;
    }

    const group: IndexedTurnItem[] = [{ item, index: i }];
    let j = i + 1;
    while (j < items.length) {
      const next = items[j];
      if (next.kind !== 'tool') break;
      const nextAgg = toolAggregation(next);
      if (!nextAgg || nextAgg.key !== agg.key) break;
      group.push({ item: next, index: j });
      j += 1;
    }

    if (group.length >= 2) {
      units.push({
        kind: 'tool_group',
        aggregationType: agg.type,
        items: group,
      });
    } else {
      units.push({ kind: 'single', item, index: i });
    }
    i = j;
  }
  return units;
}

import type { TurnRenderItem } from './messageTurnBlocks';
import { isAskQuestionTool } from '@/components/tasks/follow-up/agentQuestionModel';
import {
  isHostDelegationLifecycleTool,
  isHostDelegationTool,
} from './conversation/hostDelegation';
import {
  isCompanionMcpDiscoverySearch,
  isNativeSubagentTool,
  isSubagentLifecycleTool,
} from './tools/subagentCardModel';

export function isCollapsibleProcessItem(item: TurnRenderItem): boolean {
  if (item.kind === 'markdown' || item.kind === 'thinking') return true;
  if (item.kind !== 'tool' || !item.result || item.result.is_error)
    return false;
  const use = item.use;
  return (
    !use ||
    (!use.images?.length &&
      !isAskQuestionTool(use) &&
      !isHostDelegationTool(use) &&
      !isHostDelegationLifecycleTool(use) &&
      !isNativeSubagentTool(use) &&
      !isSubagentLifecycleTool(use) &&
      !isCompanionMcpDiscoverySearch(use))
  );
}

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

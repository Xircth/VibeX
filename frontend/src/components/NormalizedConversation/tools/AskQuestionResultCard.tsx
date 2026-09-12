import type { NormalizedEntry } from 'shared/types';
import type { ToolResultBlock, ToolUseBlock } from '../messageTurnBlocks';
import { isQuestionToolName } from '@/components/tasks/follow-up/agentQuestionModel';
import { AskQuestionToolCard } from './AskQuestionToolCard';

export function isAskQuestionToolEntry(entry: NormalizedEntry): boolean {
  return (
    entry.entry_type.type === 'tool_use' &&
    entry.entry_type.action_type.action === 'tool' &&
    isQuestionToolName(entry.entry_type.action_type.tool_name)
  );
}

export function AskQuestionResultCard({
  entry,
}: {
  entry: NormalizedEntry;
  expansionKey: string;
}) {
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : null;
  const action =
    toolEntry?.action_type.action === 'tool' ? toolEntry.action_type : null;
  if (!toolEntry || !action) return null;

  const use: ToolUseBlock = {
    type: 'tool_use',
    tool_use_id: action.tool_name,
    tool_name: action.tool_name,
    kind: null,
    input_preview:
      action.arguments == null ? null : JSON.stringify(action.arguments),
    meta: null,
  };
  const result: ToolResultBlock | null =
    action.result == null
      ? null
      : {
          type: 'tool_result',
          tool_use_id: action.tool_name,
          output_preview:
            typeof action.result.value === 'string'
              ? action.result.value
              : JSON.stringify(action.result.value),
          is_error: false,
          agent_stats: null,
        };

  return <AskQuestionToolCard use={use} result={result} />;
}

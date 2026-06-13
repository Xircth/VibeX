import { Target } from 'lucide-react';
import type { NormalizedEntry } from 'shared/types';
import { renderJson } from '../conversation-entry-utils';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';
import { readString } from './jsonValue';

function isGoalToolName(toolName: string): boolean {
  return /(^|[_-])goal([_-]|$)|create_goal|update_goal|get_goal/i.test(
    toolName
  );
}

export function isGoalToolEntry(entry: NormalizedEntry): boolean {
  return (
    entry.entry_type.type === 'tool_use' &&
    entry.entry_type.action_type.action === 'tool' &&
    isGoalToolName(entry.entry_type.action_type.tool_name)
  );
}

export function GoalToolCall({ entry }: { entry: NormalizedEntry }) {
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : null;
  const action =
    toolEntry?.action_type.action === 'tool' ? toolEntry.action_type : null;
  if (!toolEntry || !action) return null;

  const objective =
    readString(action.arguments, ['objective', 'goal']) ||
    readString(action.result?.value, ['objective', 'goal']) ||
    entry.content.trim() ||
    action.tool_name;
  const status = readString(action.result?.value, ['status', 'state']);

  return (
    <ToolCardShell
      icon={<Target className="h-3 w-3" />}
      label="目标"
      detail={status ? `${status}: ${objective}` : objective}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      expanded
      expandable={false}
    >
      <div className="conv-tool-details-section-label">目标</div>
      <div className="conv-tool-details-content">{objective}</div>
      {status ? (
        <>
          <div className="conv-tool-details-section-label">状态</div>
          <div className="conv-tool-details-content">{status}</div>
        </>
      ) : null}
      {action.result ? (
        <>
          <div className="conv-tool-details-section-label">结果</div>
          <div className="conv-tool-details-content">
            {renderJson(action.result.value)}
          </div>
        </>
      ) : null}
    </ToolCardShell>
  );
}

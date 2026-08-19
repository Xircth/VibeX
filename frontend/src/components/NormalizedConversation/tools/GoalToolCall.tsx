import { Target } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NormalizedEntry } from 'shared/types';
import { ToolArtifact, ToolFacts, ToolProse } from './ToolArtifact';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';
import { readString } from './jsonValue';
import { jsonToFacts } from './toolArtifactModel';

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
  const { t } = useTranslation(['conversation', 'common']);
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
      label={t('goalTool.title')}
      detail={status ? `${status}: ${objective}` : objective}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      status={toolEntry.status}
      expanded
      expandable={false}
    >
      <ToolArtifact badge={status || t('goalTool.title')} title={objective}>
        {action.result?.type.type === 'json' ? (
          <ToolFacts
            facts={jsonToFacts(action.result.value, {
              skipKeys: ['objective', 'goal', 'status', 'state'],
            })}
          />
        ) : action.result ? (
          <ToolProse>{objective}</ToolProse>
        ) : null}
      </ToolArtifact>
    </ToolCardShell>
  );
}

import { CircleHelp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NormalizedEntry } from 'shared/types';
import { ToolArtifact, ToolChoiceList, ToolProse } from './ToolArtifact';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';
import { readString } from './jsonValue';
import { stringList } from './toolArtifactModel';

function isQuestionToolName(toolName: string): boolean {
  return /(^|[_-])(ask|question|request_user_input)([_-]|$)/i.test(toolName);
}

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
  const { t } = useTranslation(['conversation', 'common']);
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : null;
  const action =
    toolEntry?.action_type.action === 'tool' ? toolEntry.action_type : null;
  if (!toolEntry || !action) return null;

  const question =
    readString(action.arguments, ['question', 'prompt', 'message']) ||
    entry.content.trim() ||
    action.tool_name;
  const options = stringList(
    action.arguments &&
      typeof action.arguments === 'object' &&
      !Array.isArray(action.arguments)
      ? action.arguments.options
      : null
  );
  const answer = readString(action.result?.value, [
    'answer',
    'response',
    'choice',
  ]);

  return (
    <ToolCardShell
      icon={<CircleHelp className="h-3 w-3" />}
      label={t('askQuestion.title')}
      detail={answer ? `${question} -> ${answer}` : question}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      status={toolEntry.status}
      expanded
      expandable={false}
    >
      <ToolArtifact badge={t('askQuestion.title')} title={question}>
        <ToolChoiceList items={options} selected={answer} />
        {answer ? <ToolProse>{answer}</ToolProse> : null}
      </ToolArtifact>
    </ToolCardShell>
  );
}

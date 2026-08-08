import { CircleHelp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NormalizedEntry } from 'shared/types';
import { renderJson } from '../conversation-entry-utils';
import { ToolResultView } from './ToolResultView';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';
import { readString } from './jsonValue';

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
      <div className="conv-tool-details-section-label">
        {t('askQuestion.questionLabel')}
      </div>
      <div className="conv-tool-details-content">{question}</div>
      {action.arguments ? (
        <>
          <div className="conv-tool-details-section-label">
            {t('askQuestion.optionsLabel')}
          </div>
          <div className="conv-tool-details-content">
            {renderJson(action.arguments)}
          </div>
        </>
      ) : null}
      {action.result ? (
        <>
          <div className="conv-tool-details-section-label">
            {t('askQuestion.answerLabel')}
          </div>
          <div className="conv-tool-details-content">
            <ToolResultView result={action.result} />
          </div>
        </>
      ) : null}
    </ToolCardShell>
  );
}

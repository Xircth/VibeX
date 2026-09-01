import { CircleHelp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { JsonValue, NormalizedEntry } from 'shared/types';
import { ToolArtifact, ToolChoiceList, ToolProse } from './ToolArtifact';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';
import { readString } from './jsonValue';
import { stringList } from './toolArtifactModel';

function isQuestionToolName(toolName: string): boolean {
  return /(ask_user_question|(^|[_-])(ask|question|request_user_input)([_-]|$))/i.test(
    toolName
  );
}

function selectedLabels(result: unknown): string[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return [];
  }
  const record = result as Record<string, unknown>;
  if (record.declined === true) return [];
  const answers = Array.isArray(record.answers) ? record.answers : [];
  return answers.flatMap((answer) => {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
      return [];
    }
    const selected = (answer as { selected?: unknown; labels?: unknown })
      .selected;
    const labels = (answer as { labels?: unknown }).labels;
    const values = Array.isArray(selected)
      ? selected
      : Array.isArray(labels)
        ? labels
        : [];
    return values.filter((value): value is string => typeof value === 'string');
  });
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

  const questions = Array.isArray(
    action.arguments &&
      typeof action.arguments === 'object' &&
      !Array.isArray(action.arguments)
      ? action.arguments.questions
      : null
  )
    ? (
        action.arguments as { questions: Array<{ question?: unknown }> }
      ).questions
    : [];
  const question =
    (typeof questions[0]?.question === 'string'
      ? questions[0].question
      : null) ||
    readString(action.arguments, ['question', 'prompt', 'message']) ||
    entry.content.trim() ||
    action.tool_name;
  const options = stringList(
    questions[0] &&
      typeof questions[0] === 'object' &&
      'options' in questions[0]
      ? (questions[0] as { options?: JsonValue }).options
      : action.arguments &&
          typeof action.arguments === 'object' &&
          !Array.isArray(action.arguments)
        ? action.arguments.options
        : null
  );
  const declined =
    action.result?.type.type === 'json' &&
    Boolean(
      action.result.value &&
        typeof action.result.value === 'object' &&
        !Array.isArray(action.result.value) &&
        (action.result.value as { declined?: unknown }).declined
    );
  const structured = selectedLabels(
    action.result?.type.type === 'json' ? action.result.value : null
  );
  const answer =
    structured.join(', ') ||
    readString(action.result?.value, ['answer', 'response', 'choice']);
  const detail = declined
    ? t('askQuestion.declined')
    : answer
      ? `${question} -> ${answer}`
      : question;

  return (
    <ToolCardShell
      icon={<CircleHelp className="h-3 w-3" />}
      label={t('askQuestion.title')}
      detail={detail}
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

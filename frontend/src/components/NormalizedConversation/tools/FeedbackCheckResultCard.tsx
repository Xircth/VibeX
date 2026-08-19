import { MessageSquare } from 'lucide-react';
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

function isFeedbackToolName(toolName: string): boolean {
  return /feedback|review_check|check_feedback/i.test(toolName);
}

export function isFeedbackCheckToolEntry(entry: NormalizedEntry): boolean {
  return (
    entry.entry_type.type === 'tool_use' &&
    entry.entry_type.action_type.action === 'tool' &&
    isFeedbackToolName(entry.entry_type.action_type.tool_name)
  );
}

export function FeedbackCheckResultCard({ entry }: { entry: NormalizedEntry }) {
  const { t } = useTranslation(['conversation', 'common']);
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : null;
  const action =
    toolEntry?.action_type.action === 'tool' ? toolEntry.action_type : null;
  if (!toolEntry || !action) return null;

  const summary =
    readString(action.result?.value, 'summary') ||
    readString(action.result?.value, 'message') ||
    readString(action.arguments, 'check') ||
    entry.content.trim() ||
    action.tool_name;

  return (
    <ToolCardShell
      icon={<MessageSquare className="h-3 w-3" />}
      label={t('feedbackCheck.label')}
      detail={summary}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      status={toolEntry.status}
      expanded
      expandable={false}
    >
      <ToolArtifact title={summary}>
        <ToolFacts facts={jsonToFacts(action.arguments)} />
        {action.result?.type.type === 'json' ? (
          <ToolFacts
            facts={jsonToFacts(action.result.value, {
              skipKeys: ['summary', 'message'],
            })}
          />
        ) : action.result ? (
          <ToolProse>
            <span>{summary}</span>
          </ToolProse>
        ) : null}
      </ToolArtifact>
    </ToolCardShell>
  );
}

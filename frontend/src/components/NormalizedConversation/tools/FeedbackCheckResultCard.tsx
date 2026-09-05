import { MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NormalizedEntry } from 'shared/types';
import { ToolArtifact, ToolProse } from './ToolArtifact';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';

function isFeedbackToolName(toolName: string): boolean {
  return /(check_user_feedback|feedback|review_check|check_feedback)/i.test(
    toolName
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function summaryText(record: Record<string, unknown> | null): string | null {
  const summary = record?.summary;
  return typeof summary === 'string' && summary.trim() ? summary.trim() : null;
}

function feedbackEntries(
  result: unknown
): Array<{ text: string; createdAt?: string | null }> {
  const record = asRecord(result);
  if (!record) return [];
  const envelope =
    Array.isArray(record.feedback) || typeof record.count === 'number'
      ? record
      : asRecord(record.structuredContent);
  const items = Array.isArray(envelope?.feedback)
    ? envelope.feedback.flatMap((item) => {
        const entry = asRecord(item);
        if (!entry) return [];
        const text = entry.text;
        if (typeof text !== 'string' || !text.trim()) return [];
        const createdAt =
          typeof entry.created_at === 'string'
            ? entry.created_at
            : typeof entry.createdAt === 'string'
              ? entry.createdAt
              : null;
        return [{ text, createdAt }];
      })
    : [];
  if (items.length > 0) return items;
  const summary = summaryText(envelope) ?? summaryText(record);
  return summary ? [{ text: summary }] : [];
}

function checkArgument(argumentsValue: unknown): string | null {
  const record = asRecord(argumentsValue);
  const check = record?.check;
  return typeof check === 'string' && check.trim() ? check.trim() : null;
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

  const resultValue =
    action.result?.type.type === 'json' ? action.result.value : null;
  const entries = feedbackEntries(resultValue);
  const check = checkArgument(action.arguments);
  if (entries.length === 0 && !check) return null;
  const summary = entries[0]?.text ?? check ?? t('feedbackCheck.label');

  return (
    <ToolCardShell
      icon={<MessageSquare className="h-3 w-3" />}
      label={t('feedbackCheck.label')}
      detail={check ?? t('feedbackCheck.count', { count: entries.length })}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      status={toolEntry.status}
      expanded
      expandable={false}
    >
      <ToolArtifact title={summary}>
        {entries.map((entry, index) => (
          <ToolProse key={`${entry.text}-${index}`}>{entry.text}</ToolProse>
        ))}
      </ToolArtifact>
    </ToolCardShell>
  );
}

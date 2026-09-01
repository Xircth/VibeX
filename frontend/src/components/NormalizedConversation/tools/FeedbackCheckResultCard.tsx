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

function feedbackEntries(
  result: unknown
): Array<{ text: string; createdAt?: string | null }> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return [];
  }
  const record = result as Record<string, unknown>;
  const envelope =
    Array.isArray(record.feedback) || typeof record.count === 'number'
      ? record
      : record.structuredContent &&
          typeof record.structuredContent === 'object' &&
          !Array.isArray(record.structuredContent)
        ? (record.structuredContent as Record<string, unknown>)
        : null;
  if (!envelope || !Array.isArray(envelope.feedback)) return [];
  return envelope.feedback.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const text = (item as { text?: unknown }).text;
    if (typeof text !== 'string' || !text.trim()) return [];
    const createdAt =
      typeof (item as { created_at?: unknown }).created_at === 'string'
        ? (item as { created_at: string }).created_at
        : typeof (item as { createdAt?: unknown }).createdAt === 'string'
          ? (item as { createdAt: string }).createdAt
          : null;
    return [{ text, createdAt }];
  });
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

  const entries = feedbackEntries(
    action.result?.type.type === 'json' ? action.result.value : null
  );
  if (entries.length === 0) return null;
  const summary = entries[0].text;

  return (
    <ToolCardShell
      icon={<MessageSquare className="h-3 w-3" />}
      label={t('feedbackCheck.label')}
      detail={t('feedbackCheck.count', { count: entries.length })}
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

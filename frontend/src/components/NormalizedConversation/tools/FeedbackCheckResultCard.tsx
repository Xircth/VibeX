import { MessageSquare } from 'lucide-react';
import type { JsonValue, NormalizedEntry } from 'shared/types';
import { renderJson } from '../conversation-entry-utils';
import { ToolResultView } from './ToolResultView';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';

function isRecord(value: JsonValue | null | undefined): value is {
  [key: string]: JsonValue | undefined;
} {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readString(value: JsonValue | null | undefined, key: string) {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

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
      label="反馈"
      detail={summary}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      expanded
      expandable={false}
    >
      {action.arguments ? (
        <>
          <div className="conv-tool-details-section-label">检查项</div>
          <div className="conv-tool-details-content">
            {renderJson(action.arguments)}
          </div>
        </>
      ) : null}
      {action.result ? (
        <>
          <div className="conv-tool-details-section-label">结果</div>
          <div className="conv-tool-details-content">
            <ToolResultView result={action.result} />
          </div>
        </>
      ) : null}
    </ToolCardShell>
  );
}

import { Hammer, ListTodo, PlayCircle, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { NormalizedEntry } from 'shared/types';
import type { ProcessStartPayload } from '@/types/logs';
import { useExpandable } from '@/stores/useExpandableStore';
import {
  getEntryIcon,
  getToolSummary,
  renderJson,
} from '../conversation-entry-utils';
import { ToolResultView } from './ToolResultView';
import {
  ToolCardShell,
  getToolStatusClassName,
  getToolStatusDotClassName,
} from './ToolCardShell';

function getProcessActionDetail(entry: ProcessStartPayload) {
  const actionType = entry.action?.typ;
  if (!actionType) return null;

  if (actionType.type === 'ScriptRequest') {
    return actionType.context;
  }

  if (actionType.type === 'ReviewRequest') {
    return 'Review';
  }

  return actionType.type;
}

export function GenericToolCard({
  entry,
  expansionKey,
  forceExpanded = false,
  defaultExpanded = false,
  taskAttemptId,
}: {
  entry: NormalizedEntry | ProcessStartPayload;
  expansionKey: string;
  forceExpanded?: boolean;
  defaultExpanded?: boolean;
  taskAttemptId?: string;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const isNormalizedEntry = 'entry_type' in entry;
  const toolEntry =
    isNormalizedEntry && entry.entry_type.type === 'tool_use'
      ? entry.entry_type
      : null;
  const actionType = toolEntry?.action_type ?? null;
  const [expanded, toggle] = useExpandable(
    `generic-tool-entry:${expansionKey}`,
    defaultExpanded
  );
  const effectiveExpanded = forceExpanded || expanded;

  if (!isNormalizedEntry) {
    const processDetail = getProcessActionDetail(entry);
    const hasDetails = Boolean(
      entry.runReason || entry.status || entry.startedAt || entry.action
    );

    return (
      <ToolCardShell
        icon={<PlayCircle className="h-3 w-3" />}
        label={t('genericTool.process')}
        detail={entry.runReason || processDetail || entry.status}
        expanded={effectiveExpanded}
        expandable={hasDetails}
        onToggle={toggle}
      >
        {entry.runReason ? (
          <>
            <div className="conv-tool-details-section-label">
              {t('genericTool.reason')}
            </div>
            <div className="conv-tool-details-content">{entry.runReason}</div>
          </>
        ) : null}
        <div className="conv-tool-details-section-label">
          {t('genericTool.status')}
        </div>
        <div className="conv-tool-details-content">{entry.status}</div>
        {processDetail ? (
          <>
            <div className="conv-tool-details-section-label">
              {t('genericTool.action')}
            </div>
            <div className="conv-tool-details-content">{processDetail}</div>
          </>
        ) : null}
        {entry.startedAt ? (
          <>
            <div className="conv-tool-details-section-label">
              {t('genericTool.startedAt')}
            </div>
            <div className="conv-tool-details-content">{entry.startedAt}</div>
          </>
        ) : null}
      </ToolCardShell>
    );
  }

  if (!toolEntry || !actionType) return null;

  const inlineText = entry.content.trim();
  const summary = getToolSummary(toolEntry, inlineText);
  const isTaskCreate = actionType.action === 'task_create';
  const isTodo = actionType.action === 'todo_management';
  const isGenericTool = actionType.action === 'tool';
  const isOther = actionType.action === 'other';
  const label = isTaskCreate
    ? t('genericTool.subagent')
    : isTodo
      ? t('genericTool.todo')
      : summary.label;
  const detail = isTaskCreate
    ? [actionType.subagent_type, actionType.description]
        .filter(Boolean)
        .join(': ')
    : isOther
      ? actionType.description
      : summary.detail || toolEntry.tool_name || inlineText;
  const hasDetails =
    isTaskCreate ||
    isTodo ||
    isOther ||
    (isGenericTool &&
      (Boolean(actionType.arguments) ||
        Boolean(actionType.result) ||
        inlineText.length > 0));
  const icon = isTaskCreate ? (
    <Plus className="h-3 w-3" />
  ) : isTodo ? (
    <ListTodo className="h-3 w-3" />
  ) : isGenericTool ? (
    <Hammer className="h-3 w-3" />
  ) : (
    getEntryIcon(toolEntry)
  );

  return (
    <ToolCardShell
      icon={icon}
      label={label}
      detail={detail}
      statusClassName={getToolStatusClassName(toolEntry.status)}
      statusDotClassName={getToolStatusDotClassName(toolEntry.status)}
      expanded={effectiveExpanded}
      expandable={hasDetails}
      onToggle={toggle}
    >
      {isTaskCreate ? (
        <>
          {actionType.description ? (
            <>
              <div className="conv-tool-details-section-label">
                {t('genericTool.description')}
              </div>
              <div className="conv-tool-details-content">
                {actionType.description}
              </div>
            </>
          ) : null}
          {actionType.subagent_type ? (
            <>
              <div className="conv-tool-details-section-label">
                {t('genericTool.subagent')}
              </div>
              <div className="conv-tool-details-content">
                {actionType.subagent_type}
              </div>
            </>
          ) : null}
          {actionType.result ? (
            <>
              <div className="conv-tool-details-section-label">
                {t('genericTool.result')}
              </div>
              <div className="conv-tool-details-content">
                <ToolResultView
                  result={actionType.result}
                  taskAttemptId={taskAttemptId}
                />
              </div>
            </>
          ) : null}
        </>
      ) : null}

      {isTodo ? (
        <>
          <div className="conv-tool-details-section-label">
            {t('genericTool.todo')}
          </div>
          <div className="conv-tool-details-content font-sans">
            <div className="space-y-1.5">
              {actionType.todos.map((todo, index) => (
                <div
                  key={`${todo.content}-${index}`}
                  className="flex items-start gap-2"
                >
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    {todo.status}
                  </span>
                  <span className="min-w-0 flex-1 break-words">
                    {todo.content}
                  </span>
                  {todo.priority ? (
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      {todo.priority}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}

      {isGenericTool ? (
        <>
          {actionType.arguments ? (
            <>
              <div className="conv-tool-details-section-label">
                {t('genericTool.arguments')}
              </div>
              <div className="conv-tool-details-content">
                {renderJson(actionType.arguments)}
              </div>
            </>
          ) : null}
          {actionType.result ? (
            <>
              <div className="conv-tool-details-section-label">
                {t('genericTool.result')}
              </div>
              <div className="conv-tool-details-content">
                <ToolResultView
                  result={actionType.result}
                  taskAttemptId={taskAttemptId}
                />
              </div>
            </>
          ) : null}
          {!actionType.arguments && !actionType.result && inlineText ? (
            <>
              <div className="conv-tool-details-section-label">
                {t('genericTool.content')}
              </div>
              <div className="conv-tool-details-content">{inlineText}</div>
            </>
          ) : null}
        </>
      ) : null}

      {isOther ? (
        <>
          <div className="conv-tool-details-section-label">
            {t('genericTool.description')}
          </div>
          <div className="conv-tool-details-content">
            {actionType.description}
          </div>
        </>
      ) : null}
    </ToolCardShell>
  );
}

import React, { useCallback } from 'react';
import { ActionType, NormalizedEntry, type ToolResult } from 'shared/types.ts';
import type { ProcessStartPayload } from '@/types/logs';
import { useExpandable } from '@/stores/useExpandableStore';
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  FolderOpen,
  Wrench,
} from 'lucide-react';
import RawLogText from '../common/RawLogText';
import WYSIWYGEditor from '@/components/ui/wysiwyg';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScriptFixerDialog } from '@/components/dialogs/scripts/ScriptFixerDialog';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { useTemporaryFlag } from '@/hooks/useTemporaryFlag';
import { ExpandChevron } from './MessageCard';
import { usePanelActionsContext } from '@/contexts/PanelActionsContext';
import { deriveRelativeFilePath } from '@/utils/filePaths';
import {
  renderJson,
  getEntryIcon,
  getToolExitStatus,
  getToolSummary,
  getScriptType,
  PLAN_APPEARANCE,
  type ToolStatusAppearance,
} from './conversation-entry-utils';

function renderToolResult(
  result: ToolResult | null | undefined,
  taskAttemptId?: string
) {
  if (!result) return null;

  if (result.type.type === 'markdown' && result.value) {
    return (
      <WYSIWYGEditor
        value={result.value.toString()}
        disabled
        taskAttemptId={taskAttemptId}
      />
    );
  }

  if (result.type.type === 'json') {
    return renderJson(result.value);
  }

  return null;
}

function getLookupDetail(
  actionType: Extract<
    ActionType,
    { action: 'file_read' } | { action: 'search' } | { action: 'web_fetch' }
  >
) {
  if (actionType.action === 'file_read') return actionType.path;
  if (actionType.action === 'search') return actionType.query;
  return actionType.url;
}

function resolveLookupPath(detail: string, containerRef?: string | null) {
  if (/^[a-zA-Z]:[\\/]/.test(detail) || detail.startsWith('/')) {
    return detail;
  }

  if (!containerRef) return detail;

  const usesWindows = containerRef.includes('\\');
  const separator = usesWindows ? '\\' : '/';
  const base = containerRef.replace(/[\\/]+$/, '');
  const normalized = usesWindows ? detail.replaceAll('/', '\\') : detail;
  return `${base}${separator}${normalized}`;
}

export const LookupToolCallCard: React.FC<{
  entry: NormalizedEntry;
  expansionKey: string;
  statusAppearance?: ToolStatusAppearance;
  forceExpanded?: boolean;
  containerRef?: string | null;
}> = ({
  entry,
  expansionKey,
  statusAppearance = 'default',
  forceExpanded = false,
  containerRef,
}) => {
  const toolEntry =
    entry.entry_type.type === 'tool_use' ? entry.entry_type : undefined;
  const actionType = toolEntry?.action_type;
  const isLookupAction =
    actionType?.action === 'file_read' ||
    actionType?.action === 'search' ||
    actionType?.action === 'web_fetch';
  const { label } = getToolSummary(toolEntry, entry.content.trim());
  const detail = isLookupAction ? getLookupDetail(actionType) : '';
  const normalizedDetail = detail.trim();
  const canOpenInBrowser =
    actionType?.action === 'web_fetch' &&
    /^https?:\/\//i.test(normalizedDetail);
  const canOpenPreview =
    actionType?.action === 'file_read' &&
    normalizedDetail.length > 0;
  const [copied, triggerCopied] = useTemporaryFlag(1500);
  const { openFilePreview } = usePanelActionsContext();
  const [expanded, toggle] = useExpandable(
    `lookup-entry:${expansionKey}`,
    false
  );
  const effectiveExpanded = forceExpanded || expanded;
  const statusBorderClass =
    statusAppearance === 'denied'
      ? 'conv-tool-card-error'
      : statusAppearance === 'timed_out'
        ? 'conv-tool-card-pending'
        : '';

  const handleCopy = useCallback(
    async (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(normalizedDetail || entry.content);
        triggerCopied();
      } catch {
        // Clipboard API may fail in some contexts.
      }
    },
    [entry.content, normalizedDetail, triggerCopied]
  );

  const handleOpenInBrowser = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!canOpenInBrowser) return;
      window.open(normalizedDetail, '_blank', 'noopener,noreferrer');
    },
    [canOpenInBrowser, normalizedDetail]
  );

  const handleOpenPreview = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (!canOpenPreview) return;

      const resolvedPath = resolveLookupPath(normalizedDetail, containerRef);
      const displayPath =
        deriveRelativeFilePath(resolvedPath, containerRef) ?? normalizedDetail;
      openFilePreview(resolvedPath, {
        displayPath,
        title: displayPath,
      });
    },
    [canOpenPreview, containerRef, normalizedDetail, openFilePreview]
  );

  if (!toolEntry || !isLookupAction) return null;

  return (
    <div className="w-full">
      <button
        onClick={(event: React.MouseEvent) => {
          event.preventDefault();
          toggle();
        }}
        className={cn(
          'w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm conv-tool-card',
          statusBorderClass
        )}
      >
        <span className="shrink-0 conv-tool-icon">
          {getEntryIcon(entry.entry_type)}
        </span>
        <span className="conv-tool-label shrink-0">{label}</span>
        <span className="conv-tool-detail font-mono truncate min-w-0">
          {normalizedDetail || entry.content}
        </span>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {canOpenPreview && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="Open preview"
              onClick={handleOpenPreview}
            >
              <FolderOpen className="h-3.5 w-3.5" />
            </Button>
          )}
          {canOpenInBrowser && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              title="Open link"
              onClick={handleOpenInBrowser}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            title={copied ? 'Copied' : 'Copy'}
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-600" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 text-muted-foreground transition-transform',
              effectiveExpanded ? '' : '-rotate-90'
            )}
          />
        </div>
      </button>

      {effectiveExpanded && (
        <div className="conv-tool-details text-xs font-mono">
          <div className="conv-tool-details-content">{detail || entry.content}</div>
          {toolEntry.tool_name &&
            toolEntry.tool_name !== label &&
            toolEntry.tool_name !== 'web_search' && (
              <>
                <div className="conv-tool-details-section-label">Tool</div>
                <div className="conv-tool-details-content">
                  {toolEntry.tool_name}
                </div>
              </>
            )}
        </div>
      )}
    </div>
  );
};

export const ToolCallCard: React.FC<{
  entry: NormalizedEntry | ProcessStartPayload;
  expansionKey: string;
  forceExpanded?: boolean;
  taskAttemptId?: string;
}> = ({ entry, expansionKey, forceExpanded = false, taskAttemptId }) => {
  const isNormalizedEntry = 'entry_type' in entry;
  const entryType =
    isNormalizedEntry && entry.entry_type.type === 'tool_use'
      ? entry.entry_type
      : undefined;

  const linkifyUrls = entryType?.tool_name === 'Tool Install Script';
  const defaultExpanded = linkifyUrls;

  const [expanded, toggle] = useExpandable(
    `tool-entry:${expansionKey}`,
    defaultExpanded
  );
  const effectiveExpanded = forceExpanded || expanded;

  const actionType = entryType?.action_type;
  const isCommand = actionType?.action === 'command_run';
  const isTool = actionType?.action === 'tool';
  const isTaskCreate = actionType?.action === 'task_create';
  const isTodoManagement = actionType?.action === 'todo_management';

  const inlineText = isNormalizedEntry ? entry.content.trim() : '';
  const { label, detail } = getToolSummary(entryType, inlineText);

  const commandResult = isCommand ? actionType.result : null;
  const output = commandResult?.output ?? null;
  const argsText = isCommand
    ? (
        (typeof actionType.command === 'string' ? actionType.command : '') ||
        inlineText
      ).trim()
    : null;

  const taskResult = isTaskCreate ? actionType.result : null;
  const todoItems = isTodoManagement ? actionType.todos : [];
  const hasArgs = isTool && !!actionType.arguments;
  const hasResult = isTool && !!actionType.result;

  const hasExpandableDetails = isCommand
    ? Boolean(argsText) || Boolean(output)
    : isTaskCreate
      ? Boolean(actionType.description.trim()) ||
        Boolean(actionType.subagent_type) ||
        Boolean(taskResult)
      : isTodoManagement
        ? todoItems.length > 0
        : hasArgs || hasResult;

  const exitStatus = entryType ? getToolExitStatus(entryType) : null;
  const statusBorderClass =
    !isCommand && exitStatus
      ? exitStatus === 'success'
        ? 'conv-tool-card-success'
        : exitStatus === 'error'
          ? 'conv-tool-card-error'
          : 'conv-tool-card-pending'
      : '';
  const statusDotClass = exitStatus
    ? exitStatus === 'success'
      ? 'conv-tool-dot conv-tool-dot-success'
      : exitStatus === 'error'
        ? 'conv-tool-dot conv-tool-dot-error'
        : 'conv-tool-dot conv-tool-dot-pending'
    : '';

  return (
    <div className="w-full">
      <button
        onClick={
          hasExpandableDetails
            ? (event: React.MouseEvent) => {
                event.preventDefault();
                toggle();
              }
            : undefined
        }
        className={cn(
          'w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-sm conv-tool-card',
          statusBorderClass,
          hasExpandableDetails ? 'cursor-pointer' : 'cursor-default'
        )}
      >
        <span className="shrink-0 conv-tool-icon">
          {entryType && getEntryIcon(entryType)}
        </span>
        <span className="conv-tool-label shrink-0">{label}</span>
        {detail && (
          <span className="conv-tool-detail font-mono truncate min-w-0">
            {detail}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {exitStatus && <span className={statusDotClass} />}
          {hasExpandableDetails && (
            <ChevronDown
              className={cn(
                'h-3.5 w-3.5 text-muted-foreground transition-transform',
                effectiveExpanded ? '' : '-rotate-90'
              )}
            />
          )}
        </div>
      </button>

      {effectiveExpanded && (
        <div className="conv-tool-details text-xs font-mono">
          {isCommand ? (
            <>
              {argsText && (
                <>
                  <div className="conv-tool-details-section-label">Command</div>
                  <div className="conv-tool-details-content">{argsText}</div>
                </>
              )}
              {output && (
                <>
                  <div className="conv-tool-details-section-label">Output</div>
                  <div className="conv-terminal-output">
                    <RawLogText content={output} linkifyUrls={linkifyUrls} />
                  </div>
                </>
              )}
            </>
          ) : isTaskCreate && actionType ? (
            <>
              {actionType.description && (
                <>
                  <div className="conv-tool-details-section-label">
                    Description
                  </div>
                  <div className="conv-tool-details-content">
                    {actionType.description}
                  </div>
                </>
              )}
              {actionType.subagent_type && (
                <>
                  <div className="conv-tool-details-section-label">
                    Subagent
                  </div>
                  <div className="conv-tool-details-content">
                    {actionType.subagent_type}
                  </div>
                </>
              )}
              {taskResult && (
                <>
                  <div className="conv-tool-details-section-label">Result</div>
                  <div className="conv-tool-details-content">
                    {renderToolResult(taskResult, taskAttemptId)}
                  </div>
                </>
              )}
            </>
          ) : isTodoManagement && actionType ? (
            <>
              <div className="conv-tool-details-section-label">Todos</div>
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
                      {todo.priority && (
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {todo.priority}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <>
              {isTool && actionType && (
                <>
                  <div className="conv-tool-details-section-label">
                    Arguments
                  </div>
                  <div className="conv-tool-details-content">
                    {renderJson(actionType.arguments)}
                  </div>
                  <div className="conv-tool-details-section-label">Result</div>
                  <div className="conv-tool-details-content">
                    {renderToolResult(actionType.result, taskAttemptId)}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export const ScriptToolCallCard: React.FC<{
  entry: NormalizedEntry | ProcessStartPayload;
  expansionKey: string;
  taskAttemptId?: string;
  sessionId?: string;
  isFailed: boolean;
  toolName: string;
  forceExpanded?: boolean;
}> = ({
  entry,
  expansionKey,
  taskAttemptId,
  sessionId,
  isFailed,
  toolName,
  forceExpanded = false,
}) => {
  const { repos } = useAttemptRepo(taskAttemptId);

  const handleFix = useCallback(() => {
    if (!taskAttemptId || repos.length === 0) return;

    const scriptType = getScriptType(toolName);

    ScriptFixerDialog.show({
      scriptType,
      repos,
      workspaceId: taskAttemptId,
      sessionId,
      initialRepoId: repos.length === 1 ? repos[0].id : undefined,
    });
  }, [toolName, taskAttemptId, sessionId, repos]);

  const canFix = taskAttemptId && repos.length > 0 && isFailed;

  return (
    <div className="flex items-start gap-2">
      <div className="flex-1">
        <ToolCallCard
          entry={entry}
          expansionKey={expansionKey}
          forceExpanded={forceExpanded}
          taskAttemptId={taskAttemptId}
        />
      </div>
      {canFix && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleFix}
          className="shrink-0 gap-1"
        >
          <Wrench className="h-3 w-3" />
          {'Fix Script'}
        </Button>
      )}
    </div>
  );
};

export const PlanPresentationCard: React.FC<{
  plan: string;
  expansionKey: string;
  defaultExpanded?: boolean;
  statusAppearance?: ToolStatusAppearance;
  taskAttemptId?: string;
}> = ({
  plan,
  expansionKey,
  defaultExpanded = false,
  statusAppearance = 'default',
  taskAttemptId,
}) => {
  const [expanded, toggle] = useExpandable(
    `plan-entry:${expansionKey}`,
    defaultExpanded
  );
  const tone = PLAN_APPEARANCE[statusAppearance];

  return (
    <div className="inline-block w-full">
      <div
        className={cn('w-full overflow-hidden rounded-md border', tone.border)}
      >
        <button
          onClick={(event: React.MouseEvent) => {
            event.preventDefault();
            toggle();
          }}
          title={expanded ? 'Hide plan' : 'Show plan'}
          className={cn(
            'w-full px-2 py-1.5 flex items-center gap-1.5 text-left border-b',
            tone.headerBg,
            tone.headerText,
            tone.border
          )}
        >
          <span className="min-w-0 truncate">
            <span className="font-semibold">{'Plan'}</span>
          </span>
          <div className="ml-auto flex items-center gap-2">
            <ExpandChevron
              expanded={expanded}
              onClick={toggle}
              variant={statusAppearance === 'denied' ? 'error' : 'system'}
            />
          </div>
        </button>

        {expanded && (
          <div className={cn('px-3 py-2', tone.contentBg)}>
            <div className={cn('text-sm', tone.contentText)}>
              <WYSIWYGEditor
                value={plan}
                disabled
                className="whitespace-pre-wrap break-words"
                taskAttemptId={taskAttemptId}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

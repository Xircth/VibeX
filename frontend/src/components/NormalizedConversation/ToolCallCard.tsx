import React, { useCallback } from 'react';
import {
  NormalizedEntry,
} from 'shared/types.ts';
import type { ProcessStartPayload } from '@/types/logs';
import { useExpandable } from '@/stores/useExpandableStore';
import {
  ChevronDown,
  Wrench,
} from 'lucide-react';
import RawLogText from '../common/RawLogText';
import WYSIWYGEditor from '@/components/ui/wysiwyg';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  ScriptFixerDialog,
} from '@/components/dialogs/scripts/ScriptFixerDialog';
import { useAttemptRepo } from '@/hooks/useAttemptRepo';
import { ExpandChevron } from './MessageCard';
import {
  renderJson,
  getEntryIcon,
  getToolExitStatus,
  getToolSummary,
  getScriptType,
  PLAN_APPEARANCE,
  type ToolStatusAppearance,
} from './conversation-entry-utils';

/***********************
 * Phase 4: ToolCallCard — status dots + left border
 ***********************/

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

  const inlineText = isNormalizedEntry ? entry.content.trim() : '';
  const { label, detail } = getToolSummary(entryType, inlineText);

  // Command details
  const commandResult = isCommand ? actionType.result : null;
  const output = commandResult?.output ?? null;
  let argsText: string | null = null;
  if (isCommand) {
    const fromArgs =
      typeof actionType.command === 'string' ? actionType.command : '';
    const fallback = inlineText;
    argsText = (fromArgs || fallback).trim();
  }

  const hasArgs = isTool && !!actionType.arguments;
  const hasResult = isTool && !!actionType.result;

  const hasExpandableDetails = isCommand
    ? Boolean(argsText) || Boolean(output)
    : hasArgs || hasResult;

  // Determine status for left border and dot
  // For command_run (terminal): no left-border coloring, status dot goes to the right
  const exitStatus = entryType ? getToolExitStatus(entryType) : null;
  // Only apply colored left border for non-terminal tools
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
            ? (e: React.MouseEvent) => {
                e.preventDefault();
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
        {/* Right-side: status dot + expand chevron */}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {/* Status dot — always on the right */}
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
                  <div className="conv-tool-details-section-label">
                    参数
                  </div>
                  <div className="conv-tool-details-content">
                    {argsText}
                  </div>
                </>
              )}
              {output && (
                <>
                  <div className="conv-tool-details-section-label">
                    输出
                  </div>
                  <div className="conv-terminal-output">
                    <RawLogText content={output} linkifyUrls={linkifyUrls} />
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              {isTool && actionType && (
                <>
                  <div className="conv-tool-details-section-label">
                    参数
                  </div>
                  <div className="conv-tool-details-content">
                    {renderJson(actionType.arguments)}
                  </div>
                  <div className="conv-tool-details-section-label">
                    结果
                  </div>
                  <div className="conv-tool-details-content">
                    {actionType.result?.type.type === 'markdown' &&
                      actionType.result.value && (
                        <WYSIWYGEditor
                          value={actionType.result.value?.toString()}
                          disabled
                          taskAttemptId={taskAttemptId}
                        />
                      )}
                    {actionType.result?.type.type === 'json' &&
                      renderJson(actionType.result.value)}
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
          {'修复脚本'}
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
          onClick={(e: React.MouseEvent) => {
            e.preventDefault();
            toggle();
          }}
          title={expanded ? '隐藏计划' : '显示计划'}
          className={cn(
            'w-full px-2 py-1.5 flex items-center gap-1.5 text-left border-b',
            tone.headerBg,
            tone.headerText,
            tone.border
          )}
        >
          <span className=" min-w-0 truncate">
            <span className="font-semibold">{'计划'}</span>
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

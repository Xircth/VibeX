import '@/styles/conversation.css';
import { useMemo } from 'react';
import WYSIWYGEditor from '@/components/ui/wysiwyg';
import {
  ActionType,
  NormalizedEntry,
  type NormalizedEntryType,
  type TaskWithAttemptStatus,
} from 'shared/types.ts';
import type { WorkspaceWithSession } from '@/types/attempt';
import type { ProcessStartPayload } from '@/types/logs';
import FileChangeRenderer from './FileChangeRenderer';
import { Markdown } from './Markdown';
import UserMessage from './UserMessage';
import PendingApprovalEntry from './PendingApprovalEntry';
import { cn } from '@/lib/utils';
import { useRetryUi } from '@/contexts/RetryUiContext';
import { useTaskStopping } from '@/stores/useTaskDetailsUiStore';
import { getContextCompactStatusKind } from '@/lib/contextCompact';

// Re-exported from extracted modules
export { getAggregatableAction } from './conversation-entry-utils';
export { AggregatedGroupCard } from './AggregatedGroupCard';

import {
  shouldRenderMarkdown,
  getContentClassName,
  getToolStatusAppearance,
  isPendingApprovalStatus,
  SCRIPT_TOOL_NAMES,
  getCompactMetaNoticeText,
  getCompactVerboseErrorText,
  shouldHideInitializationNotice,
  isNeutralTransportNotice,
  repairTokenizedStreamContent,
  sanitizeConversationContent,
  splitLeadingCodexUnstableFeatureNotice,
  splitLeadingImpeccablePreflightNotice,
  splitLeadingTransportNotice,
  type FileEditAction,
} from './conversation-entry-utils';
import {
  CompactNoticeEntry,
  ContextCompactStatusEntry,
  PlainNoticeEntry,
} from './MessageCard';
import { ThinkingEntry } from './ThinkingEntry';
import {
  ToolCallCard,
  ScriptToolCallCard,
  PlanPresentationCard,
  LookupToolCallCard,
} from './ToolCallCard';
import { LoadingCard, CopyButton } from './LoadingCard';

type Props = {
  entry: NormalizedEntry | ProcessStartPayload;
  expansionKey: string;
  diffDeletable?: boolean;
  executionProcessId?: string;
  taskAttempt?: WorkspaceWithSession;
  task?: TaskWithAttemptStatus;
};

/*******************
 * Main component  *
 *******************/

export const DisplayConversationEntryMaxWidth = (props: Props) => {
  return <DisplayConversationEntry {...props} />;
};

function DisplayConversationEntry({
  entry,
  expansionKey,
  executionProcessId,
  taskAttempt,
  task,
}: Props) {
  const isNormalizedEntry = (
    entry: NormalizedEntry | ProcessStartPayload
  ): entry is NormalizedEntry => 'entry_type' in entry;

  const isProcessStart = (
    entry: NormalizedEntry | ProcessStartPayload
  ): entry is ProcessStartPayload => 'processId' in entry;

  const { isProcessGreyed } = useRetryUi();
  const greyed = isProcessGreyed(executionProcessId);
  const { isStopping } = useTaskStopping(taskAttempt?.task_id ?? '');
  const markdownContext = useMemo(
    () => ({
      taskAttemptId: taskAttempt?.id,
      taskId: task?.id ?? taskAttempt?.task_id,
      workspacePath: taskAttempt?.container_ref,
    }),
    [
      task?.id,
      taskAttempt?.container_ref,
      taskAttempt?.id,
      taskAttempt?.task_id,
    ]
  );

  if (isProcessStart(entry)) {
    return (
      <div
        className={cn(
          'conv-entry-item',
          greyed && 'opacity-50 pointer-events-none'
        )}
      >
        <div className="px-4 py-1 text-sm">
          <ToolCallCard
            entry={entry}
            expansionKey={expansionKey}
            taskAttemptId={taskAttempt?.id}
          />
        </div>
      </div>
    );
  }

  // Handle NormalizedEntry
  const entryType = entry.entry_type;
  const rawContentText = isNormalizedEntry(entry)
    ? sanitizeConversationContent(entry.content)
    : '';
  const contentText =
    entryType.type === 'assistant_message'
      ? repairTokenizedStreamContent(rawContentText)
      : rawContentText;
  const isSystem = entryType.type === 'system_message';
  const isError = entryType.type === 'error_message';
  const isToolUse = entryType.type === 'tool_use';
  const isUserMessage = entryType.type === 'user_message';
  const isUserFeedback = entryType.type === 'user_feedback';
  const isLoading = entryType.type === 'loading';
  const isTokenUsage = entryType.type === 'token_usage_info';
  const isFileEdit = (a: ActionType): a is FileEditAction =>
    a.action === 'file_edit';

  if (isTokenUsage) {
    return null;
  }

  if (shouldHideInitializationNotice(entryType, contentText)) {
    return null;
  }

  if (isUserMessage) {
    return (
      <div className="conv-entry-item">
        <UserMessage
          content={entry.content}
          executionProcessId={executionProcessId}
          taskAttempt={taskAttempt}
        />
      </div>
    );
  }

  if (isUserFeedback) {
    const feedbackEntry = entryType as Extract<
      NormalizedEntryType,
      { type: 'user_feedback' }
    >;
    return (
      <div className="conv-entry-item px-4 py-1.5">
        <div className="conv-feedback-card">
          <div className="conv-feedback-label">
            {`用户拒绝了 ${feedbackEntry.denied_tool}`}
          </div>
          <WYSIWYGEditor
            value={entry.content}
            disabled
            className="whitespace-pre-wrap break-words flex flex-col gap-1 font-light"
            taskAttemptId={taskAttempt?.id}
          />
        </div>
      </div>
    );
  }

  const renderToolUse = () => {
    if (!isNormalizedEntry(entry)) return null;
    if (entryType.type !== 'tool_use') return null;
    const toolEntry = entryType;

    const status = toolEntry.status;
    const statusAppearance = getToolStatusAppearance(status);
    const isPlanPresentation =
      toolEntry.action_type.action === 'plan_presentation';
    const isPendingApproval = status.status === 'pending_approval';
    const defaultExpanded = isPendingApproval || isPlanPresentation;

    const body = (() => {
      if (isFileEdit(toolEntry.action_type)) {
        const fileEditAction = toolEntry.action_type as FileEditAction;
        return (
          <div className="space-y-3">
            {fileEditAction.changes.map((change, idx) => (
              <FileChangeRenderer
                key={idx}
                path={fileEditAction.path}
                change={change}
                expansionKey={`edit:${expansionKey}:${idx}`}
                defaultExpanded={defaultExpanded}
                statusAppearance={statusAppearance}
                forceExpanded={isPendingApproval}
                containerRef={taskAttempt?.container_ref}
              />
            ))}
          </div>
        );
      }

      if (toolEntry.action_type.action === 'plan_presentation') {
        return (
          <PlanPresentationCard
            plan={toolEntry.action_type.plan}
            expansionKey={expansionKey}
            defaultExpanded={defaultExpanded}
            statusAppearance={statusAppearance}
            taskAttemptId={taskAttempt?.id}
          />
        );
      }

      if (
        toolEntry.action_type.action === 'file_read' ||
        toolEntry.action_type.action === 'search' ||
        toolEntry.action_type.action === 'web_fetch'
      ) {
        return (
          <LookupToolCallCard
            entry={entry}
            expansionKey={expansionKey}
            statusAppearance={statusAppearance}
            forceExpanded={isPendingApproval}
            containerRef={taskAttempt?.container_ref}
          />
        );
      }

      // Script entries
      if (
        toolEntry.action_type.action === 'command_run' &&
        SCRIPT_TOOL_NAMES.includes(toolEntry.tool_name)
      ) {
        const actionType = toolEntry.action_type;
        const exitCode =
          actionType.result?.exit_status?.type === 'exit_code'
            ? actionType.result.exit_status.code
            : null;
        const isFailed = exitCode !== null && exitCode !== 0;

        return (
          <ScriptToolCallCard
            entry={entry}
            expansionKey={expansionKey}
            taskAttemptId={taskAttempt?.id}
            sessionId={taskAttempt?.session?.id}
            isFailed={isFailed}
            toolName={toolEntry.tool_name}
            forceExpanded={isPendingApproval}
          />
        );
      }

      return (
        <ToolCallCard
          entry={entry}
          expansionKey={expansionKey}
          forceExpanded={isPendingApproval}
          taskAttemptId={taskAttempt?.id}
        />
      );
    })();

    const content = (
      <div
        className={`px-4 py-1 text-sm space-y-1 ${greyed ? 'opacity-50 pointer-events-none' : ''}`}
      >
        {body}
      </div>
    );

    if (isPendingApprovalStatus(status)) {
      return (
        <PendingApprovalEntry
          pendingStatus={status}
          executionProcessId={executionProcessId}
        >
          {content}
        </PendingApprovalEntry>
      );
    }

    return content;
  };

  if (isToolUse) {
    return <div className="conv-entry-item">{renderToolUse()}</div>;
  }

  // Phase 3: Show thinking blocks for ALL executors (removed CODEX restriction)
  if (entryType.type === 'thinking') {
    return (
      <div className="conv-entry-item">
        <ThinkingEntry
          content={isNormalizedEntry(entry) ? entry.content : ''}
          expansionKey={expansionKey}
          taskAttemptId={taskAttempt?.id}
        />
      </div>
    );
  }

  if (isSystem || isError) {
    const contextCompactStatus = getContextCompactStatusKind(contentText);
    if (contextCompactStatus) {
      return (
        <div
          className={cn(
            'conv-entry-item px-4 py-2',
            greyed && 'opacity-50 pointer-events-none'
          )}
        >
          <ContextCompactStatusEntry
            content={contentText}
            status={contextCompactStatus}
          />
        </div>
      );
    }

    const compactNoticeText = getCompactMetaNoticeText(entryType, contentText);
    const verboseErrorText = getCompactVerboseErrorText(contentText);

    if (compactNoticeText) {
      const noticeVariant = isNeutralTransportNotice(contentText)
        ? 'system'
        : isSystem
          ? 'system'
          : 'error';
      return (
        <div
          className={cn(
            'conv-entry-item px-4 py-1',
            greyed && 'opacity-50 pointer-events-none'
          )}
        >
          <CompactNoticeEntry
            content={compactNoticeText}
            variant={noticeVariant}
            title={contentText}
          />
        </div>
      );
    }

    if (verboseErrorText) {
      return (
        <div
          className={cn(
            'conv-entry-item px-4 py-1',
            greyed && 'opacity-50 pointer-events-none'
          )}
        >
          <CompactNoticeEntry
            content={verboseErrorText}
            variant={isSystem ? 'system' : 'error'}
            title={contentText}
          />
        </div>
      );
    }

    return (
      <div
        className={cn(
          'conv-entry-item px-4 py-1',
          greyed && 'opacity-50 pointer-events-none'
        )}
      >
        <PlainNoticeEntry
          content={contentText}
          markdown={shouldRenderMarkdown(entryType)}
          className={getContentClassName(entryType)}
          title={contentText}
          markdownContext={markdownContext}
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="conv-entry-item px-4 py-2 text-sm">
        <LoadingCard
          label={isStopping ? '正在停止Hook...' : undefined}
          shimmer={!isStopping}
        />
      </div>
    );
  }

  if (entry.entry_type.type === 'next_action') {
    return null;
  }

  // Phase 2: Assistant message with hover copy button
  const leadingImpeccablePreflightNotice =
    splitLeadingImpeccablePreflightNotice(contentText);
  if (leadingImpeccablePreflightNotice) {
    if (!leadingImpeccablePreflightNotice.remainder.trim()) {
      return (
        <div
          className={cn(
            'conv-entry-item px-4 py-1',
            greyed && 'opacity-50 pointer-events-none'
          )}
        >
          <CompactNoticeEntry
            content={leadingImpeccablePreflightNotice.notice}
            variant="system"
            title={leadingImpeccablePreflightNotice.notice}
          />
        </div>
      );
    }

    return (
      <>
        <div
          className={cn(
            'conv-entry-item px-4 py-1',
            greyed && 'opacity-50 pointer-events-none'
          )}
        >
          <CompactNoticeEntry
            content={leadingImpeccablePreflightNotice.notice}
            variant="system"
            title={leadingImpeccablePreflightNotice.notice}
          />
        </div>
        <div className="conv-entry-item conv-assistant-msg conv-msg-hover group px-4 py-2 text-sm">
          <div className="relative">
            <div className={getContentClassName(entryType)}>
              {shouldRenderMarkdown(entryType) ? (
                <Markdown
                  value={leadingImpeccablePreflightNotice.remainder}
                  {...markdownContext}
                />
              ) : (
                leadingImpeccablePreflightNotice.remainder
              )}
            </div>
            {isNormalizedEntry(entry) && (
              <div className="absolute -right-1 top-0">
                <CopyButton text={leadingImpeccablePreflightNotice.remainder} />
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  const leadingTransportNotice = splitLeadingTransportNotice(contentText);
  if (leadingTransportNotice) {
    return (
      <>
        <div
          className={cn(
            'conv-entry-item px-4 py-1',
            greyed && 'opacity-50 pointer-events-none'
          )}
        >
          <CompactNoticeEntry
            content={leadingTransportNotice.notice}
            variant="system"
            title={leadingTransportNotice.notice}
          />
        </div>
        <div className="conv-entry-item conv-assistant-msg conv-msg-hover group px-4 py-2 text-sm">
          <div className="relative">
            <div className={getContentClassName(entryType)}>
              {shouldRenderMarkdown(entryType) ? (
                <Markdown
                  value={leadingTransportNotice.remainder}
                  {...markdownContext}
                />
              ) : (
                leadingTransportNotice.remainder
              )}
            </div>
            {isNormalizedEntry(entry) &&
              leadingTransportNotice.remainder.trim().length > 0 && (
                <div className="absolute -right-1 top-0">
                  <CopyButton text={leadingTransportNotice.remainder} />
                </div>
              )}
          </div>
        </div>
      </>
    );
  }

  const leadingCodexUnstableFeatureNotice =
    splitLeadingCodexUnstableFeatureNotice(contentText);
  if (leadingCodexUnstableFeatureNotice) {
    if (!leadingCodexUnstableFeatureNotice.remainder.trim()) {
      return (
        <div
          className={cn(
            'conv-entry-item px-4 py-1',
            greyed && 'opacity-50 pointer-events-none'
          )}
        >
          <CompactNoticeEntry
            content={leadingCodexUnstableFeatureNotice.notice}
            variant="system"
            title={leadingCodexUnstableFeatureNotice.notice}
          />
        </div>
      );
    }

    return (
      <>
        <div
          className={cn(
            'conv-entry-item px-4 py-1',
            greyed && 'opacity-50 pointer-events-none'
          )}
        >
          <CompactNoticeEntry
            content={leadingCodexUnstableFeatureNotice.notice}
            variant="system"
            title={leadingCodexUnstableFeatureNotice.notice}
          />
        </div>
        <div className="conv-entry-item conv-assistant-msg conv-msg-hover group px-4 py-2 text-sm">
          <div className="relative">
            <div className={getContentClassName(entryType)}>
              {shouldRenderMarkdown(entryType) ? (
                <Markdown
                  value={leadingCodexUnstableFeatureNotice.remainder}
                  {...markdownContext}
                />
              ) : (
                leadingCodexUnstableFeatureNotice.remainder
              )}
            </div>
            {isNormalizedEntry(entry) &&
              leadingCodexUnstableFeatureNotice.remainder.trim().length > 0 && (
                <div className="absolute -right-1 top-0">
                  <CopyButton
                    text={leadingCodexUnstableFeatureNotice.remainder}
                  />
                </div>
              )}
          </div>
        </div>
      </>
    );
  }

  const compactNoticeText = getCompactMetaNoticeText(entryType, contentText);

  if (compactNoticeText) {
    return (
      <div
        className={cn(
          'conv-entry-item px-4 py-1',
          greyed && 'opacity-50 pointer-events-none'
        )}
      >
        <CompactNoticeEntry
          content={compactNoticeText}
          variant="system"
          title={contentText}
        />
      </div>
    );
  }

  return (
    <div className="conv-entry-item conv-assistant-msg conv-msg-hover group px-4 py-2 text-sm">
      <div className="relative">
        <div className={getContentClassName(entryType)}>
          {shouldRenderMarkdown(entryType) ? (
            <Markdown value={contentText} {...markdownContext} />
          ) : (
            contentText
          )}
        </div>
        {isNormalizedEntry(entry) && entry.content.trim().length > 0 && (
          <div className="absolute -right-1 top-0">
            <CopyButton text={entry.content} />
          </div>
        )}
      </div>
    </div>
  );
}

export default DisplayConversationEntryMaxWidth;

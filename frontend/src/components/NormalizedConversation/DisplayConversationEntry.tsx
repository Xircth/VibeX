import '@/styles/conversation.css';
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
import { NextActionCard } from './NextActionCard';
import { cn } from '@/lib/utils';
import { useRetryUi } from '@/contexts/RetryUiContext';

// Re-exported from extracted modules
export { getAggregatableAction } from './conversation-entry-utils';
export { AggregatedGroupCard } from './AggregatedGroupCard';

import {
  shouldRenderMarkdown,
  getContentClassName,
  getToolStatusAppearance,
  isPendingApprovalStatus,
  SCRIPT_TOOL_NAMES,
  type FileEditAction,
} from './conversation-entry-utils';
import { CollapsibleEntry } from './MessageCard';
import { ThinkingEntry } from './ThinkingEntry';
import { ToolCallCard, ScriptToolCallCard, PlanPresentationCard } from './ToolCallCard';
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

  if (isProcessStart(entry)) {
    return (
      <div className={cn('conv-entry-item', greyed && 'opacity-50 pointer-events-none')}>
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
    return (
      <div
        className={cn(
          'conv-entry-item px-4 py-2 text-sm',
          greyed && 'opacity-50 pointer-events-none'
        )}
      >
        <CollapsibleEntry
          content={isNormalizedEntry(entry) ? entry.content : ''}
          markdown={shouldRenderMarkdown(entryType)}
          expansionKey={expansionKey}
          variant={isSystem ? 'system' : 'error'}
          contentClassName={getContentClassName(entryType)}
          taskAttemptId={taskAttempt?.id}
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="conv-entry-item px-4 py-2 text-sm">
        <LoadingCard />
      </div>
    );
  }

  if (entry.entry_type.type === 'next_action') {
    return (
      <div className="conv-entry-item px-4 py-2 text-sm">
        <NextActionCard
          attemptId={taskAttempt?.id}
          sessionId={taskAttempt?.session?.id}
          containerRef={taskAttempt?.container_ref}
          failed={entry.entry_type.failed}
          execution_processes={entry.entry_type.execution_processes}
          task={task}
          needsSetup={entry.entry_type.needs_setup}
        />
      </div>
    );
  }

  // Phase 2: Assistant message with hover copy button
  const contentText = isNormalizedEntry(entry) ? entry.content : '';
  return (
    <div className="conv-entry-item conv-assistant-msg conv-msg-hover group px-4 py-2 text-sm">
      <div className="relative">
        <div className={getContentClassName(entryType)}>
          {shouldRenderMarkdown(entryType) ? (
            <Markdown value={contentText} />
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

import { memo, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type {
  AgentElicitationResponse,
  ConversationDelegationView,
  MessageTurn,
  TaskWithAttemptStatus,
  TimelineRow,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import {
  MessageTurnView,
  type ContextCompactPresentation,
} from '@/components/NormalizedConversation/MessageTurnView';
import { TurnFileChangesCard } from '@/components/NormalizedConversation/TurnFileChangesCard';
import { QuestionRequestCard } from '@/components/NormalizedConversation/conversation/QuestionRequestCard';
import { ArtifactTimelineCard } from '@/components/NormalizedConversation/ArtifactTimelineCard';
import {
  findMatchingAskQuestionTool,
  type TimelineQuestion,
} from '@/components/NormalizedConversation/TurnActivity';
import { mergeQuestionRequestWithToolUse } from '@/components/tasks/follow-up/agentQuestionModel';
import { TimelineAgentHandoffRow } from '@/components/NormalizedConversation/ContextHandoffDivider';
import { AgentRuntimeStatus } from '@/components/tasks/follow-up/AgentRuntimeStatus';
import type { InlineStreamRuntimeStatus } from '@/features/conversation/inlineRuntimeStatus';
import {
  isDurableHostNote,
  parseAgentHandoffNotice,
  type ConversationTimelineItem,
  type ConversationTimelineTurn,
} from '@/features/conversation/conversationStore';
import {
  virtualRowFoldEdge,
  type AssistantBlockSlice,
} from '@/components/logs/assistantVirtualSlices';
import { getVirtualRowTranslateY } from '@/components/logs/VirtualizedList';
import { cn } from '@/lib/utils';
import { TurnStats } from './thread/TurnStats';
import { LiveTurnStats } from './thread/LiveTurnStats';
import type { TurnStatsData } from './thread/turnStatsModel';
import type { SelectableAgent } from '@/features/agents/useSelectableAgents';
import {
  assistantCopyText,
  buildSettledTurnStats,
  dimoTurnIdFromTimelineRowId,
  mergeMissingTurnStats,
} from './timelineMemoHelpers';

export function InlineTimelineSideRow({
  entry,
  timeline,
  dismissedQuestionIds,
  onDismissQuestion,
  onRespondQuestion,
  responding,
}: {
  entry: TimelineRow;
  timeline: ConversationTimelineTurn[];
  dismissedQuestionIds: ReadonlySet<string>;
  onDismissQuestion: (questionId: string) => void;
  onRespondQuestion: (
    questionId: string,
    response: AgentElicitationResponse
  ) => void | Promise<unknown>;
  responding: boolean;
}) {
  const row = entry.row;
  if (row.kind === 'question_request') {
    if (!row.response && dismissedQuestionIds.has(row.request.question_id)) {
      return null;
    }
    const matchedUse = findMatchingAskQuestionTool(row.request, timeline);
    return (
      <QuestionRequestCard
        request={mergeQuestionRequestWithToolUse(row.request, matchedUse)}
        response={row.response ?? null}
        onRespond={onRespondQuestion}
        onDismiss={onDismissQuestion}
        responding={responding}
      />
    );
  }
  if (row.kind === 'feedback_request') {
    return (
      <div className="rounded-md border border-info/30 bg-info/10 px-3 py-2 text-xs text-info-foreground">
        <div className="font-medium">Feedback requested</div>
        <div className="mt-1 whitespace-pre-wrap break-words text-info-foreground/80">
          {row.request.prompt}
        </div>
      </div>
    );
  }
  if (row.kind === 'terminal_summary') {
    return (
      <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium text-foreground">
          {row.terminal.command ?? 'Terminal'} · {row.terminal.status}
        </div>
        {row.terminal.output_summary ? (
          <div className="mt-1 whitespace-pre-wrap break-words">
            {row.terminal.output_summary}
          </div>
        ) : null}
      </div>
    );
  }
  if (row.kind === 'artifact_revision') {
    return <ArtifactTimelineCard artifact={row.artifact} />;
  }
  if (row.kind === 'session_notice') {
    const handoff = parseAgentHandoffNotice(entry);
    if (handoff) {
      return <TimelineAgentHandoffRow handoff={handoff} />;
    }
    if (isDurableHostNote(entry)) {
      return (
        <div className="conv-entry-item px-4 py-1">
          <div className="conv-compact-notice whitespace-pre-wrap break-words text-[var(--text-primary)]">
            <div className="text-xs text-[var(--text-muted)]">
              {row.notice.title}
            </div>
            {row.notice.message ? <div>{row.notice.message}</div> : null}
          </div>
        </div>
      );
    }
  }
  return null;
}

export interface TimelineVirtualRowItemProps {
  virtualIndex: number;
  virtualStart: number;
  scrollMargin: number;
  measureElement: (node: HTMLDivElement | null) => void;
  item: ConversationTimelineItem;
  timeline: ConversationTimelineTurn[];
  slice: AssistantBlockSlice | null;
  isLastSlice: boolean;
  foldEdge: ReturnType<typeof virtualRowFoldEdge>;
  isActiveNavTarget: boolean;
  isCurrentFindMatch: boolean;
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  workspacePath: string | null;
  collapseProcess: boolean;
  expandFileChanges: boolean;
  delegations: ConversationDelegationView[];
  questions: TimelineQuestion[];
  dismissedQuestionIds: ReadonlySet<string>;
  onDismissQuestion: (questionId: string) => void;
  onOpenChild: (childConversationId: string) => void;
  contextCompact: ContextCompactPresentation | null;
  hasTurnError: boolean;
  userOrdinal: number;
  isEditableUser: boolean;
  onRetryTurn: (
    turn: MessageTurn,
    ordinal: number,
    replacementText?: string
  ) => Promise<boolean>;
  onRespondQuestion: (
    questionId: string,
    response: AgentElicitationResponse
  ) => void | Promise<unknown>;
  isRespondingQuestion: boolean;
  fileChanges: Extract<
    TimelineRow['row'],
    { kind: 'file_change_summary' }
  > | null;
  onUndoTurnChanges: (turnId: string) => Promise<void> | void;
  isTurnInFlight: boolean;
  forkAgents: readonly SelectableAgent[];
  jumpTarget: number | null;
  onJumpToVirtualIndex: (index: number) => void;
  onForkFromTurn: (
    turnId?: string,
    targetAgentId?: string
  ) => Promise<void> | void;
  liveStatsFallback: TurnStatsData | null;
  streamingLiveStatus: {
    hideStatus: boolean;
    statusLabel: string;
    stats: TurnStatsData;
  } | null;
  suppressStreamingStatus?: boolean;
  suppressStatusRowPadding?: boolean;
  hideAssistantStats?: boolean;
}

export const TimelineVirtualRowItem = memo(function TimelineVirtualRowItem({
  virtualIndex,
  virtualStart,
  scrollMargin,
  measureElement,
  item,
  timeline,
  slice,
  isLastSlice,
  foldEdge,
  isActiveNavTarget,
  isCurrentFindMatch,
  attempt,
  task,
  workspacePath,
  collapseProcess,
  expandFileChanges,
  delegations,
  questions,
  dismissedQuestionIds,
  onDismissQuestion,
  onOpenChild,
  contextCompact,
  hasTurnError,
  userOrdinal,
  isEditableUser,
  onRetryTurn,
  onRespondQuestion,
  isRespondingQuestion,
  fileChanges,
  onUndoTurnChanges,
  isTurnInFlight,
  forkAgents,
  jumpTarget,
  onJumpToVirtualIndex,
  onForkFromTurn,
  liveStatsFallback,
  streamingLiveStatus,
  suppressStreamingStatus = false,
  suppressStatusRowPadding = false,
  hideAssistantStats = false,
}: TimelineVirtualRowItemProps) {
  const row = item.kind === 'message' ? item.item : null;
  const turnId = row ? dimoTurnIdFromTimelineRowId(row.turn.id) : null;

  const handleUserRetry = useCallback(() => {
    if (!row) return;
    void onRetryTurn(row.turn, userOrdinal);
  }, [onRetryTurn, row, userOrdinal]);

  const handleUserEditRetry = useCallback(
    (editedText: string) => {
      if (!row) return Promise.resolve(false);
      return onRetryTurn(row.turn, userOrdinal, editedText);
    },
    [onRetryTurn, row, userOrdinal]
  );

  const handleUndo = useCallback(() => {
    if (!turnId) return;
    void onUndoTurnChanges(turnId);
  }, [onUndoTurnChanges, turnId]);

  const onJumpBack = useMemo(
    () =>
      jumpTarget === null
        ? null
        : () => {
            onJumpToVirtualIndex(jumpTarget);
          },
    [jumpTarget, onJumpToVirtualIndex]
  );

  const onForkFromHere = useMemo(
    () =>
      turnId
        ? (targetAgentId: string) => {
            void onForkFromTurn(turnId, targetAgentId);
          }
        : null,
    [onForkFromTurn, turnId]
  );

  const assistantStats = useMemo(() => {
    if (
      hideAssistantStats ||
      !row ||
      !isLastSlice ||
      row.turn.role !== 'assistant'
    ) {
      return null;
    }
    const copyText = assistantCopyText(row.turn);
    if (streamingLiveStatus) {
      return {
        kind: 'live' as const,
        copyText,
      };
    }
    const settled = buildSettledTurnStats(row.turn);
    const stats = liveStatsFallback
      ? mergeMissingTurnStats(settled, liveStatsFallback)
      : settled;
    const forkDisabled =
      isTurnInFlight || row.phase === 'streaming' || row.phase === 'optimistic';
    return {
      kind: 'settled' as const,
      copyText,
      stats,
      forkDisabled,
      forkDisabledReason: 'busy' as const,
    };
  }, [
    hideAssistantStats,
    isLastSlice,
    isTurnInFlight,
    liveStatsFallback,
    row,
    streamingLiveStatus,
  ]);

  return (
    <div
      ref={measureElement}
      data-index={virtualIndex}
      data-turn-id={turnId ?? undefined}
      data-message-id={row?.turn.id}
      data-block-index={slice?.kind === 'block' ? slice.itemIndex : undefined}
      className={cn(
        'conv-turn-row absolute left-0 top-0 w-full',
        foldEdge === 'tail'
          ? 'is-fold-tail'
          : suppressStatusRowPadding
            ? undefined
            : 'pb-3',
        foldEdge === 'after' && 'is-after-fold',
        isActiveNavTarget && 'conv-message-nav-target-active',
        isCurrentFindMatch && 'rounded-md bg-primary/10'
      )}
      style={{
        transform: getVirtualRowTranslateY(virtualStart, scrollMargin),
      }}
    >
      {item.kind === 'side' ? (
        <InlineTimelineSideRow
          entry={item.row}
          timeline={timeline}
          dismissedQuestionIds={dismissedQuestionIds}
          onDismissQuestion={onDismissQuestion}
          onRespondQuestion={onRespondQuestion}
          responding={isRespondingQuestion}
        />
      ) : null}
      {row ? (
        <MessageTurnView
          turn={row.turn}
          phase={row.phase}
          attempt={attempt}
          task={task}
          workspacePath={workspacePath}
          onRetry={row.turn.role === 'user' ? handleUserRetry : undefined}
          onEditRetry={isEditableUser ? handleUserEditRetry : undefined}
          collapseProcess={collapseProcess}
          delegations={delegations}
          questions={questions}
          onOpenChild={onOpenChild}
          showInterruptedNotice={false}
          contextCompact={contextCompact}
          hasTurnError={hasTurnError}
          suppressStreamingStatus={suppressStreamingStatus}
          slice={slice}
          isLastSlice={isLastSlice}
        />
      ) : null}
      {row?.turn.role === 'assistant' &&
      isLastSlice &&
      fileChanges &&
      turnId ? (
        <div className="min-w-0 px-4">
          <TurnFileChangesCard
            summary={fileChanges.summary}
            expansionKey={`turn-files:${turnId}`}
            defaultExpanded={expandFileChanges}
            onUndo={handleUndo}
            undoDisabled={isTurnInFlight}
          />
        </div>
      ) : null}
      {row && assistantStats?.kind === 'live' && streamingLiveStatus ? (
        <LiveTurnStats
          hideStatus={streamingLiveStatus.hideStatus}
          statusLabel={streamingLiveStatus.statusLabel}
          stats={streamingLiveStatus.stats}
          startedAt={row.turn.timestamp}
          copyText={assistantStats.copyText}
          onJumpBack={onJumpBack}
        />
      ) : null}
      {assistantStats?.kind === 'settled' ? (
        <TurnStats
          stats={assistantStats.stats}
          copyText={assistantStats.copyText}
          onJumpBack={onJumpBack}
          onForkFromHere={onForkFromHere}
          forkAgents={forkAgents}
          forkDisabled={assistantStats.forkDisabled}
          forkDisabledReason={assistantStats.forkDisabledReason}
        />
      ) : null}
    </div>
  );
});

export function InlineStreamRuntimeRow({
  status,
  onReveal,
  onReconnect,
  onCancel,
  onRetry,
}: {
  status: InlineStreamRuntimeStatus;
  onReveal: () => void;
  onReconnect: () => void | Promise<unknown>;
  onCancel: () => void | Promise<unknown>;
  onRetry?: () => void | Promise<unknown>;
}) {
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;
  const phaseKey =
    status.notice.connection_status?.status ??
    status.notice.request_status?.activity.phase ??
    status.kind;

  useLayoutEffect(() => {
    onRevealRef.current();
  }, [status.kind, phaseKey, status.titleOverride]);

  return (
    <AgentRuntimeStatus
      notice={status.notice}
      placement="stream"
      titleOverride={status.titleOverride}
      onReconnect={status.canReconnect ? onReconnect : undefined}
      onCancel={status.canCancel ? onCancel : undefined}
      onRetry={status.canRetry ? onRetry : undefined}
    />
  );
}

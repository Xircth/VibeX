import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Bot, Loader2, X } from 'lucide-react';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  MessageTurn,
  TaskWithAttemptStatus,
  TimelineRow,
} from 'shared/types';

import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { AgentTypeIcon } from '@/components/agents/AgentTypeIcon';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { QuestionRequestCard } from '@/components/NormalizedConversation/conversation/QuestionRequestCard';
import { TurnErrorCard } from '@/components/NormalizedConversation/conversation/TurnErrorCard';
import { ArtifactTimelineCard } from '@/components/NormalizedConversation/ArtifactTimelineCard';
import { MessageTurnView } from '@/components/NormalizedConversation/MessageTurnView';
import { SubagentLifecycleProvider } from '@/components/NormalizedConversation/tools/SubagentLifecycleContext';
import { toast } from '@/components/ui/toast';
import {
  type ConversationTimelineItem,
  type ConversationTimelineTurn,
} from '@/features/conversation/conversationStore';
import { useConversationTimeline } from '@/features/conversation/useConversationTimeline';
import { resolveConversationCollapsePreferences } from '@/lib/conversationCollapsePreferences';
import type { WorkspaceWithSession } from '@/types/attempt';
import { agentDisplayLabel } from './DelegationCard';

const CONVERSATION_REGION_SELECTOR = '.right-panel-conversation-region';

export function ChildConversationViewer({
  conversationId,
  agentId: agentIdHint,
  taskPreview,
  attempt,
  task,
  workspacePath,
  onClose,
  onOpenChild,
}: {
  conversationId: string;
  agentId?: string | null;
  taskPreview?: string | null;
  attempt: WorkspaceWithSession;
  task: TaskWithAttemptStatus | null;
  workspacePath?: string | null;
  onClose: () => void;
  onOpenChild?: (childConversationId: string) => void;
}) {
  const { t } = useTranslation(['conversation', 'common']);
  const { config } = useOptionalUserSystem() ?? {};
  const { collapseAiMessages } = resolveConversationCollapsePreferences(config);
  const conversation = useConversationTimeline(conversationId);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const messages = conversation.timeline;
  const agentId = conversation.agentId ?? agentIdHint ?? null;
  const title = agentId ? agentDisplayLabel(agentId) : t('childViewer.title');
  const stream = useMemo(
    () =>
      childConversationStream(
        conversation.items,
        messages,
        taskPreview ?? null
      ),
    [conversation.items, messages, taskPreview]
  );
  const leftoverSideRows = useMemo(
    () => leftoverUninlinedSideRows(conversation.sideRows, stream),
    [conversation.sideRows, stream]
  );
  const delegations = useMemo(
    () =>
      conversation.sideRows.flatMap((row) =>
        row.row.kind === 'delegation' ? [row.row.delegation] : []
      ),
    [conversation.sideRows]
  );

  useLayoutEffect(() => {
    const node = document.querySelector(CONVERSATION_REGION_SELECTOR);
    setHost(node instanceof HTMLElement ? node : null);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const respondPermission = (
    permissionId: string,
    response: AgentPermissionResponse
  ) => {
    setRespondingId(permissionId);
    void conversation
      .respondPermission(permissionId, response)
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : String(error))
      )
      .finally(() => setRespondingId(null));
  };
  const respondQuestion = (
    questionId: string,
    response: AgentElicitationResponse
  ) => {
    setRespondingId(questionId);
    void conversation
      .respondQuestion(questionId, response)
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : String(error))
      )
      .finally(() => setRespondingId(null));
  };

  const overlay = (
    <div
      data-testid="child-conversation-backdrop"
      className="absolute inset-0 z-40 flex items-stretch justify-center bg-background/70 p-5 backdrop-blur-md"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="child-conversation-viewer-title"
        data-testid="child-conversation-viewer"
        className="flex h-full max-h-full w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-[var(--surface-control)] text-popover-foreground shadow-[var(--shadow-popover)]"
      >
        <header className="flex h-10 shrink-0 items-center gap-2 px-4">
          <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
            {agentId ? (
              <AgentTypeIcon agentType={agentId} className="h-5 w-5" />
            ) : (
              <Bot className="h-5 w-5" />
            )}
          </span>
          <h2
            id="child-conversation-viewer-title"
            className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
          >
            {title}
          </h2>
          <button
            type="button"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
            onClick={onClose}
            aria-label={t('childViewer.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div
          data-testid="child-conversation-thread"
          className="mx-3 mb-3 min-h-0 flex-1 overflow-hidden rounded-xl bg-background"
        >
          <div className="h-full overflow-y-auto px-2 py-3">
            {conversation.loading && messages.length === 0 ? (
              <div className="flex min-h-[160px] items-center justify-center text-muted-foreground">
                <div className="flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-xs shadow-sm">
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
                  <span>{t('childViewer.loading')}</span>
                </div>
              </div>
            ) : stream.length === 0 && leftoverSideRows.length === 0 ? (
              <div className="grid min-h-[160px] place-items-center text-xs text-muted-foreground">
                {conversation.error ?? t('childViewer.empty')}
              </div>
            ) : (
              <SubagentLifecycleProvider
                turns={messages.map((row) => row.turn)}
              >
                <div className="conv-thread-shell relative mx-auto w-full">
                  <div className="conv-thread-content min-w-0 space-y-3">
                    {stream.map((entry) => {
                      if (entry.kind === 'message') {
                        return (
                          <MessageTurnView
                            key={entry.item.key}
                            turn={entry.item.turn}
                            phase={entry.item.phase}
                            attempt={attempt}
                            task={task}
                            workspacePath={workspacePath}
                            collapseProcess={collapseAiMessages}
                            showInterruptedNotice={false}
                            delegations={delegations}
                            onOpenChild={onOpenChild}
                          />
                        );
                      }
                      return (
                        <ChildInlineSideRow
                          key={entry.row.row_id}
                          entry={entry.row}
                          respondingId={respondingId}
                          onRespondQuestion={respondQuestion}
                        />
                      );
                    })}
                    {leftoverSideRows.map((entry) => {
                      if (entry.row.kind === 'permission_request') {
                        return (
                          <PermissionRequestCard
                            key={entry.row_id}
                            request={entry.row.request}
                            responding={
                              respondingId === entry.row.request.permission_id
                            }
                            onRespond={respondPermission}
                          />
                        );
                      }
                      if (entry.row.kind === 'turn_error') {
                        return (
                          <TurnErrorCard
                            key={entry.row_id}
                            error={entry.row.error.error}
                          />
                        );
                      }
                      return null;
                    })}
                    {conversation.error ? (
                      <div
                        role="alert"
                        className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                      >
                        {conversation.error}
                      </div>
                    ) : null}
                  </div>
                </div>
              </SubagentLifecycleProvider>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return host ? createPortal(overlay, host) : overlay;
}

function ChildInlineSideRow({
  entry,
  respondingId,
  onRespondQuestion,
}: {
  entry: TimelineRow;
  respondingId: string | null;
  onRespondQuestion: (
    questionId: string,
    response: AgentElicitationResponse
  ) => void;
}) {
  const row = entry.row;
  if (row.kind === 'question_request') {
    return (
      <QuestionRequestCard
        request={row.request}
        response={row.response ?? null}
        onRespond={onRespondQuestion}
        responding={respondingId === row.request.question_id}
      />
    );
  }
  if (row.kind === 'feedback_request') {
    return (
      <div className="rounded-md border border-violet-300/50 bg-violet-50 px-3 py-2 text-xs text-violet-950 dark:border-violet-500/30 dark:bg-violet-950/25 dark:text-violet-100">
        <div className="font-medium">Feedback requested</div>
        <div className="mt-1 whitespace-pre-wrap break-words text-violet-800/80 dark:text-violet-100/75">
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
  return null;
}

function childConversationStream(
  items: ConversationTimelineItem[],
  messages: ConversationTimelineTurn[],
  taskPreview: string | null
): ConversationTimelineItem[] {
  const stream =
    items.length > 0
      ? items
      : messages.map((item) => ({
          kind: 'message' as const,
          revision: item.revision,
          item,
        }));
  const hasUser = stream.some(
    (entry) => entry.kind === 'message' && entry.item.turn.role === 'user'
  );
  const prompt = taskPreview?.trim();
  if (hasUser || !prompt) return stream;
  return [delegatedTaskItem(prompt), ...stream];
}

function leftoverUninlinedSideRows(
  sideRows: TimelineRow[],
  stream: ConversationTimelineItem[]
): TimelineRow[] {
  const inlined = new Set(
    stream.flatMap((entry) => (entry.kind === 'side' ? [entry.row.row_id] : []))
  );
  return sideRows.filter((row) => !inlined.has(row.row_id));
}

function delegatedTaskItem(text: string): ConversationTimelineItem {
  const turn: MessageTurn = {
    id: 'delegated-task:user',
    role: 'user',
    blocks: [{ type: 'text', text }],
    timestamp: new Date(0).toISOString(),
  };
  return {
    kind: 'message',
    revision: 0n,
    item: {
      key: 'delegated-task:user',
      phase: 'persisted',
      revision: 0n,
      turn,
    },
  };
}

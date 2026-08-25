import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  TaskWithAttemptStatus,
} from 'shared/types';

import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { QuestionRequestCard } from '@/components/NormalizedConversation/conversation/QuestionRequestCard';
import { TurnErrorCard } from '@/components/NormalizedConversation/conversation/TurnErrorCard';
import { DelegationCard } from '@/components/NormalizedConversation/conversation/DelegationCard';
import {
  hostDelegationToolUseIds,
  shouldInlineDelegationSideRow,
} from '@/components/NormalizedConversation/conversation/hostDelegation';
import { MessageTurnView } from '@/components/NormalizedConversation/MessageTurnView';
import { SubagentLifecycleProvider } from '@/components/NormalizedConversation/tools/SubagentLifecycleContext';
import { toast } from '@/components/ui/toast';
import { useConversationTimeline } from '@/features/conversation/useConversationTimeline';
import { resolveConversationCollapsePreferences } from '@/lib/conversationCollapsePreferences';
import type { WorkspaceWithSession } from '@/types/attempt';

export function ChildConversationViewer({
  conversationId,
  attempt,
  task,
  workspacePath,
  onClose,
  onOpenChild,
}: {
  conversationId: string;
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
  const messages = conversation.timeline;
  const hostDelegationIds = useMemo(
    () => hostDelegationToolUseIds(messages.map((item) => item.turn)),
    [messages]
  );
  const delegations = useMemo(
    () =>
      conversation.sideRows.flatMap((row) =>
        row.row.kind === 'delegation' ? [row.row.delegation] : []
      ),
    [conversation.sideRows]
  );

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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="child-conversation-viewer-title"
      data-testid="child-conversation-viewer"
      className="absolute inset-0 z-30 flex flex-col bg-background"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5 pr-3">
        <h2
          id="child-conversation-viewer-title"
          className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
        >
          {t('childViewer.title')}
        </h2>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-[var(--surface-control-hover)] hover:text-foreground focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)]"
          onClick={onClose}
          aria-label={t('childViewer.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {conversation.loading && messages.length === 0 ? (
          <div className="flex min-h-[160px] items-center justify-center text-muted-foreground">
            <div className="flex items-center gap-2 rounded-full border bg-background/90 px-3 py-1.5 text-xs shadow-sm">
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
              <span>{t('childViewer.loading')}</span>
            </div>
          </div>
        ) : messages.length === 0 && conversation.sideRows.length === 0 ? (
          <div className="grid min-h-[160px] place-items-center text-xs text-muted-foreground">
            {conversation.error ?? t('childViewer.empty')}
          </div>
        ) : (
          <SubagentLifecycleProvider turns={messages.map((row) => row.turn)}>
            <div className="conv-thread-content space-y-3">
              {messages.map((message) => (
                <MessageTurnView
                  key={message.key}
                  turn={message.turn}
                  phase={message.phase}
                  attempt={attempt}
                  task={task}
                  workspacePath={workspacePath}
                  collapseProcess={collapseAiMessages}
                  showInterruptedNotice={false}
                  delegations={delegations}
                  onOpenChild={onOpenChild}
                />
              ))}
              {conversation.sideRows.map((entry) => {
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
                if (entry.row.kind === 'question_request') {
                  return (
                    <QuestionRequestCard
                      key={entry.row_id}
                      request={entry.row.request}
                      response={entry.row.response}
                      responding={
                        respondingId === entry.row.request.question_id
                      }
                      onRespond={respondQuestion}
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
                if (
                  entry.row.kind === 'delegation' &&
                  shouldInlineDelegationSideRow(
                    entry.row.delegation.parent_tool_call_id,
                    hostDelegationIds
                  )
                ) {
                  return (
                    <DelegationCard
                      key={entry.row_id}
                      delegation={entry.row.delegation}
                      onOpenChild={onOpenChild}
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
          </SubagentLifecycleProvider>
        )}
      </div>
    </div>
  );
}

import { useContext, useMemo, useState } from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useInRouterContext } from 'react-router-dom';
import { ChatComposer } from '@astryxdesign/core/Chat';
import { Check, CirclePlay } from 'lucide-react';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  WorkflowStepView,
} from 'shared/types';

import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { KanbanSessionConversationView } from '@/components/kanban/KanbanSessionConversationView';
import { Button } from '@/components/ui/button';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { QuestionRequestCard } from '@/components/NormalizedConversation/conversation/QuestionRequestCard';
import { TurnErrorCard } from '@/components/NormalizedConversation/conversation/TurnErrorCard';
import { MessageTurnView } from '@/components/NormalizedConversation/MessageTurnView';
import { hasMatchingAskQuestionTool } from '@/components/NormalizedConversation/TurnActivity';
import { ConversationTimelineSkeleton } from '@/components/logs/ConversationTimelineSkeleton';
import { useConversationTimeline } from '@/features/conversation/useConversationTimeline';
import { toast } from '@/components/ui/toast';
import { resolveConversationCollapsePreferences } from '@/lib/conversationCollapsePreferences';
import '@/styles/conversation.css';

export function WorkflowStepConversation({
  stepRun,
  saved,
  workspacePath,
  isTestable = false,
  onTestNode,
  onPause,
  onSubmit,
  onConfirm,
}: {
  stepRun?: WorkflowStepView;
  saved: boolean;
  workspacePath?: string | null;
  isTestable?: boolean;
  onTestNode?: () => Promise<void> | void;
  onPause?: () => void;
  onSubmit?: (text: string) => Promise<void> | void;
  onConfirm?: () => Promise<void> | void;
}) {
  const { t } = useTranslation('workflow');
  const queryClient = useContext(QueryClientContext);
  const inRouter = useInRouterContext();
  const canEmbedSessionSurface = Boolean(
    stepRun?.workspaceId && stepRun?.conversationId && queryClient && inRouter
  );

  const { config } = useOptionalUserSystem() ?? {};
  const { collapseAiMessages } = resolveConversationCollapsePreferences(config);
  const conversation = useConversationTimeline(
    canEmbedSessionSurface ? null : (stepRun?.conversationId ?? null)
  );
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const messages = useMemo(
    () => conversation.timeline,
    [conversation.timeline]
  );
  const timelineQuestions = useMemo(
    () =>
      conversation.sideRows.flatMap((row) =>
        row.row.kind === 'question_request'
          ? [
              {
                request: row.row.request,
                response: row.row.response ?? null,
              },
            ]
          : []
      ),
    [conversation.sideRows]
  );
  const turnRunning =
    stepRun?.status === 'running' && !stepRun.awaitingInput && !sending;
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

  if (
    canEmbedSessionSurface &&
    stepRun?.workspaceId &&
    stepRun?.conversationId
  ) {
    return (
      <div
        data-testid="workflow-step-embedded-session"
        className="flex h-full min-h-0 flex-col gap-2"
      >
        <KanbanSessionConversationView
          workspaceId={stepRun.workspaceId}
          sessionId={stepRun.conversationId}
          interactive
          embedded
          showSessionSelector={false}
          conversationWidthMode="bounded"
          markViewed={false}
          className="min-h-0 flex-1 overflow-hidden rounded-[var(--radius-element)]"
        />
        {onConfirm ? (
          <Button className="shrink-0" onClick={() => void onConfirm()}>
            <Check className="mr-1.5 size-3.5" />
            {t('studio.confirmComplete')}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="min-h-0 flex-1 space-y-2 overflow-auto px-1 py-0.5">
        {!stepRun?.conversationId ? (
          <div className="grid min-h-28 place-items-center gap-2 text-center text-xs text-muted-foreground">
            {onTestNode && isTestable ? (
              <Button
                size="sm"
                variant="outline"
                data-testid="workflow-step-start-test"
                onClick={() => void onTestNode()}
              >
                <CirclePlay className="mr-1.5 size-3.5" />
                {t('studio.testNode')}
              </Button>
            ) : (
              <span>{t('studio.conversationPending')}</span>
            )}
          </div>
        ) : conversation.loading && messages.length === 0 ? (
          <ConversationTimelineSkeleton
            label={t('studio.conversationLoading')}
          />
        ) : messages.length === 0 ? (
          <div className="grid min-h-28 place-items-center text-xs text-muted-foreground">
            {t('studio.noMessages')}
          </div>
        ) : (
          messages.map((message) => (
            <MessageTurnView
              key={message.key}
              turn={message.turn}
              phase={message.phase}
              attempt={
                {
                  id: stepRun?.workspaceId ?? 'workflow-step',
                  container_ref: workspacePath ?? null,
                } as never
              }
              task={null}
              workspacePath={workspacePath}
              collapseProcess={collapseAiMessages}
              questions={timelineQuestions}
            />
          ))
        )}
        {conversation.sideRows.map((entry) => {
          if (entry.row.kind === 'permission_request') {
            return (
              <PermissionRequestCard
                key={entry.row_id}
                request={entry.row.request}
                responding={respondingId === entry.row.request.permission_id}
                onRespond={respondPermission}
              />
            );
          }
          if (entry.row.kind === 'question_request') {
            if (
              entry.row.response &&
              hasMatchingAskQuestionTool(entry.row.request, messages)
            ) {
              return null;
            }
            return (
              <QuestionRequestCard
                key={entry.row_id}
                request={entry.row.request}
                response={entry.row.response}
                responding={respondingId === entry.row.request.question_id}
                onRespond={respondQuestion}
              />
            );
          }
          if (entry.row.kind === 'turn_error') {
            return (
              <TurnErrorCard key={entry.row_id} error={entry.row.error.error} />
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

      <ChatComposer
        className="workflow-step-chat-composer shrink-0"
        density="compact"
        elevation="none"
        value={text}
        onChange={setText}
        isDisabled={!saved || !onSubmit || sending}
        isStopShown={turnRunning}
        onStop={onPause}
        placeholder=""
        onSubmit={(value) => {
          const message = value.trim();
          if (!message || !onSubmit || turnRunning) return;
          setSending(true);
          Promise.resolve(onSubmit(message))
            .then(() => setText(''))
            .catch((error) =>
              toast.error(
                error instanceof Error ? error.message : String(error)
              )
            )
            .finally(() => setSending(false));
        }}
      />
      {onConfirm ? (
        <Button className="shrink-0" onClick={() => void onConfirm()}>
          <Check className="mr-1.5 size-3.5" />
          {t('studio.confirmComplete')}
        </Button>
      ) : null}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatComposer } from '@astryxdesign/core/Chat';
import { Check } from 'lucide-react';
import type {
  AgentElicitationResponse,
  AgentPermissionResponse,
  WorkflowStepView,
} from 'shared/types';

import { useOptionalUserSystem } from '@/components/ConfigProvider';
import { Button } from '@/components/ui/button';
import { PermissionRequestCard } from '@/components/NormalizedConversation/conversation/PermissionRequestCard';
import { QuestionRequestCard } from '@/components/NormalizedConversation/conversation/QuestionRequestCard';
import { TurnErrorCard } from '@/components/NormalizedConversation/conversation/TurnErrorCard';
import { MessageTurnView } from '@/components/NormalizedConversation/MessageTurnView';
import { useConversationTimeline } from '@/features/conversation/useConversationTimeline';
import { toast } from '@/components/ui/toast';
import { resolveConversationCollapsePreferences } from '@/lib/conversationCollapsePreferences';
import '@/styles/conversation.css';

export function WorkflowStepConversation({
  stepRun,
  saved,
  workspacePath,
  onPause,
  onSubmit,
  onConfirm,
}: {
  stepRun?: WorkflowStepView;
  saved: boolean;
  workspacePath?: string | null;
  onPause?: () => void;
  onSubmit?: (text: string) => Promise<void> | void;
  onConfirm?: () => Promise<void> | void;
}) {
  const { t } = useTranslation('workflow');
  const { config } = useOptionalUserSystem() ?? {};
  const { collapseAiMessages } = resolveConversationCollapsePreferences(config);
  const conversation = useConversationTimeline(stepRun?.conversationId ?? null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const messages = useMemo(
    () => conversation.timeline,
    [conversation.timeline]
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

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="min-h-0 flex-1 space-y-2 overflow-auto px-1 py-0.5">
        {!stepRun?.conversationId ? (
          <div className="grid min-h-28 place-items-center text-center text-xs text-muted-foreground">
            {t('studio.conversationPending')}
          </div>
        ) : conversation.loading && messages.length === 0 ? (
          <div className="grid min-h-28 place-items-center text-xs text-muted-foreground">
            {t('studio.conversationLoading')}
          </div>
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

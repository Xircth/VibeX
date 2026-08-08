import { useTranslation } from 'react-i18next';
import type {
  AgentElicitationResponse,
  ConversationQuestionRequest,
  ConversationQuestionResponse,
} from 'shared/types';
import { AgentQuestionCard } from '@/components/tasks/follow-up/AgentQuestionCard';

/**
 * Pending questions normally dock behind the composer. This component remains
 * the timeline fallback for read-only surfaces and the compact answered state.
 */
export function QuestionRequestCard({
  request,
  response,
  onRespond,
  responding = false,
}: {
  request: ConversationQuestionRequest;
  response?: ConversationQuestionResponse | null;
  onRespond: (questionId: string, response: AgentElicitationResponse) => void;
  responding?: boolean;
}) {
  const { t } = useTranslation(['conversation']);

  if (!response) {
    return (
      <div className="agent-question-timeline-fallback">
        <AgentQuestionCard
          request={request}
          responding={responding}
          onRespond={onRespond}
        />
      </div>
    );
  }

  return (
    <div className="conv-entry-item rounded-lg border border-border bg-card px-3 py-2.5 text-sm text-card-foreground">
      <div className="font-medium">{request.prompt}</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {t('questionRequestCard.answered')}
        {response.answer ? ` · ${response.answer}` : ''}
      </div>
    </div>
  );
}

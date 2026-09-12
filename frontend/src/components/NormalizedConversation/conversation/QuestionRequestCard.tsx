import type {
  AgentElicitationResponse,
  ConversationQuestionRequest,
  ConversationQuestionResponse,
} from 'shared/types';
import { AgentQuestionCard } from '@/components/tasks/follow-up/AgentQuestionCard';
import { AskQuestionToolCard } from '@/components/NormalizedConversation/tools/AskQuestionToolCard';

/**
 * Pending questions normally dock behind the composer. This remains the
 * timeline fallback for read-only surfaces; answered questions reuse the
 * tool-card details surface instead of a compact bubble.
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
  if (response) {
    return <AskQuestionToolCard request={request} response={response} />;
  }

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

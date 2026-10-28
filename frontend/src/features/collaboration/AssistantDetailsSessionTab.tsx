import { useMemo, useState } from 'react';

import { SessionDetailsView } from '@/components/panels/session-details/SessionDetailsView';
import { SessionQuota } from '@/components/panels/session-details/SessionQuota';
import { buildSessionDetails } from '@/components/panels/session-details/sessionDetailsModel';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  useConversationSessionFacts,
  useConversationTimeline,
} from '@/features/conversation/useConversationTimeline';
import { requestConversationScrollToTurn } from '@/lib/conversationScroll';

export function AssistantDetailsSessionTab({
  conversationId,
}: {
  conversationId: string | null | undefined;
}) {
  const sessionId = conversationId?.trim() || null;
  const conversation = useConversationTimeline(sessionId);
  const facts = useConversationSessionFacts(sessionId);
  const panelActions = useOptionalPanelActionsContext();
  const [quotaActive, setQuotaActive] = useState(false);

  const model = useMemo(
    () =>
      buildSessionDetails({
        facts,
        turns: conversation.timeline,
        sideRows: conversation.sideRows,
        branch: null,
        configOptions: conversation.sessionConfigOptions,
        currentTurnId: conversation.currentTurnId,
      }),
    [
      conversation.currentTurnId,
      conversation.sessionConfigOptions,
      conversation.sideRows,
      conversation.timeline,
      facts,
    ]
  );

  return (
    <div
      className="collaboration-assistant-details-session"
      data-testid="collaboration-assistant-details-session"
    >
      <SessionDetailsView
        model={model.kind === 'ready' ? { ...model, messages: [] } : model}
        showMessages={false}
        quota={
          <SessionQuota agentId={facts.agentId} onActive={setQuotaActive} />
        }
        quotaActive={quotaActive}
        onJumpToMessage={(turnId) => {
          if (!sessionId) return;
          requestConversationScrollToTurn(sessionId, turnId);
        }}
        onOpenFile={(path) => {
          panelActions?.openFilePreview(path);
        }}
      />
    </div>
  );
}

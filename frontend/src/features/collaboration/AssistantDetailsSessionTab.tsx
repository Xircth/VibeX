import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Session } from 'shared/types';

import { SessionDetailsView } from '@/components/panels/session-details/SessionDetailsView';
import { SessionQuota } from '@/components/panels/session-details/SessionQuota';
import { buildSessionDetails } from '@/components/panels/session-details/sessionDetailsModel';
import { useOptionalPanelActionsContext } from '@/contexts/PanelActionsContext';
import {
  useConversationSessionFacts,
  useConversationTimeline,
} from '@/features/conversation/useConversationTimeline';
import { requestConversationScrollToTurn } from '@/lib/conversationScroll';
import {
  SESSION_AGENT_SWITCHED_EVENT,
  type SessionAgentSwitchedDetail,
} from '@/lib/sessionQueryCache';

export function AssistantDetailsSessionTab({
  conversationId,
  fallbackAgentId,
}: {
  conversationId: string | null | undefined;
  fallbackAgentId?: string | null;
}) {
  const sessionId = conversationId?.trim() || null;
  const queryClient = useQueryClient();
  const [switchedAgentId, setSwitchedAgentId] = useState<string | null>(null);
  const conversation = useConversationTimeline(sessionId);
  const rawFacts = useConversationSessionFacts(sessionId);

  useEffect(() => {
    setSwitchedAgentId(null);
    if (!sessionId || typeof window === 'undefined') return;
    const handleSwitched = (event: Event) => {
      const detail = (event as CustomEvent<SessionAgentSwitchedDetail>).detail;
      if (detail?.sessionId === sessionId && detail.agentId) {
        setSwitchedAgentId(detail.agentId);
      }
    };
    window.addEventListener(SESSION_AGENT_SWITCHED_EVENT, handleSwitched);
    return () => {
      window.removeEventListener(SESSION_AGENT_SWITCHED_EVENT, handleSwitched);
    };
  }, [sessionId]);

  const cachedSession = sessionId
    ? queryClient.getQueryData<Session | null>(['session', sessionId])
    : null;
  const resolvedFallbackAgentId =
    switchedAgentId ||
    fallbackAgentId?.trim() ||
    cachedSession?.agent_id ||
    cachedSession?.executor ||
    null;
  const facts = useMemo(
    () =>
      rawFacts.agentId || !resolvedFallbackAgentId
        ? rawFacts
        : { ...rawFacts, agentId: resolvedFallbackAgentId },
    [rawFacts, resolvedFallbackAgentId]
  );
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

import { useEffect, useSyncExternalStore } from 'react';
import {
  getConversationSessionFacts,
  getConversationTimelineView,
  retainConversationTimeline,
  subscribeConversationTimeline,
  type ConversationSessionFacts,
  type ConversationTimelineView,
} from './conversationTimelineRegistry';

export type UseConversationTimelineResult = ConversationTimelineView;

export function useConversationTimeline(
  conversationId: string | null,
  options?: { active?: boolean }
): UseConversationTimelineResult {
  const isActive = options?.active ?? true;
  const snapshot = useSyncExternalStore(
    subscribeConversationTimeline,
    () => getConversationTimelineView(conversationId),
    () => getConversationTimelineView(conversationId)
  );
  useEffect(() => {
    if (!conversationId || !isActive) return;
    return retainConversationTimeline(conversationId);
  }, [conversationId, isActive]);
  return snapshot;
}

export function useConversationSessionFacts(
  conversationId: string | null
): ConversationSessionFacts {
  return useSyncExternalStore(
    subscribeConversationTimeline,
    () => getConversationSessionFacts(conversationId),
    () => getConversationSessionFacts(conversationId)
  );
}

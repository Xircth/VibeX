import { backendListen } from '@/lib/backendTransport';
import type { ConversationRowOpBatch } from 'shared/types';

// The realtime channel now carries backend-computed row-op batches (消灭双投影), not
// raw event envelopes; the frontend never folds events.
export const CONVERSATION_EVENTS_CHANNEL = 'conversation-events';

export function conversationEventsChannel(conversationId: string): string {
  return `${CONVERSATION_EVENTS_CHANNEL}:${conversationId}`;
}

export const CONVERSATION_RATE_LIMIT_CHANNEL = 'conversation-rate-limit';

export function conversationRateLimitChannel(conversationId: string): string {
  return `${CONVERSATION_RATE_LIMIT_CHANNEL}:${conversationId}`;
}

export function listenToConversationEvents(
  onBatch: (batch: ConversationRowOpBatch) => void,
  conversationId?: string
): Promise<() => void> {
  return backendListen<ConversationRowOpBatch>(
    conversationId
      ? conversationEventsChannel(conversationId)
      : CONVERSATION_EVENTS_CHANNEL,
    onBatch
  );
}

export function listenToConversationRateLimitEvents(
  conversationId: string,
  onEvent: (payload: unknown) => void
): Promise<() => void> {
  return backendListen<unknown>(
    conversationRateLimitChannel(conversationId),
    onEvent
  );
}

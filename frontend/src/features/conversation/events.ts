import { backendListen } from '@/lib/backendTransport';
import type { ConversationRowOpBatch } from 'shared/types';

// The realtime channel now carries backend-computed row-op batches (消灭双投影), not
// raw event envelopes; the frontend never folds events.
export const CONVERSATION_EVENTS_CHANNEL = 'conversation-events';

export function listenToConversationEvents(
  onBatch: (batch: ConversationRowOpBatch) => void
): Promise<() => void> {
  return backendListen<ConversationRowOpBatch>(
    CONVERSATION_EVENTS_CHANNEL,
    onBatch
  );
}

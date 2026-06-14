import { tauriListen } from '@/lib/tauriApi';
import type { ConversationEventEnvelope } from 'shared/types';

export const CONVERSATION_EVENTS_CHANNEL = 'conversation-events';

export function listenToConversationEvents(
  onEvent: (event: ConversationEventEnvelope) => void
): Promise<() => void> {
  return tauriListen<ConversationEventEnvelope>(
    CONVERSATION_EVENTS_CHANNEL,
    onEvent
  );
}

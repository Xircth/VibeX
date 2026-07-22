import type { MessageTurn } from 'shared/types';

export type OptimisticConversationTurnEvent =
  | {
      type: 'add';
      conversationId: string;
      turn: MessageTurn;
    }
  | {
      type: 'remove';
      conversationId: string;
      turnId: string;
    };

type OptimisticConversationTurnListener = (
  event: OptimisticConversationTurnEvent
) => void;

const listeners = new Set<OptimisticConversationTurnListener>();

export function publishOptimisticConversationTurn(
  event: OptimisticConversationTurnEvent
): void {
  listeners.forEach((listener) => listener(event));
}

export function subscribeToOptimisticConversationTurns(
  listener: OptimisticConversationTurnListener
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

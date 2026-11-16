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

type BufferedOptimisticTurn = {
  turn: MessageTurn;
  bufferedAt: number;
};

const OPTIMISTIC_TURN_BUFFER_TTL_MS = 30_000;

const listeners = new Set<OptimisticConversationTurnListener>();
const pendingByConversationId = new Map<string, BufferedOptimisticTurn[]>();

function pruneExpiredBufferedTurns(now = Date.now()): void {
  for (const [conversationId, entries] of pendingByConversationId) {
    const fresh = entries.filter(
      (entry) => now - entry.bufferedAt <= OPTIMISTIC_TURN_BUFFER_TTL_MS
    );
    if (fresh.length === 0) {
      pendingByConversationId.delete(conversationId);
    } else if (fresh.length !== entries.length) {
      pendingByConversationId.set(conversationId, fresh);
    }
  }
}

export function publishOptimisticConversationTurn(
  event: OptimisticConversationTurnEvent
): void {
  const now = Date.now();
  pruneExpiredBufferedTurns(now);
  if (event.type === 'add') {
    const existing = pendingByConversationId.get(event.conversationId) ?? [];
    const deduped = existing.filter((entry) => entry.turn.id !== event.turn.id);
    deduped.push({ turn: event.turn, bufferedAt: now });
    pendingByConversationId.set(event.conversationId, deduped);
  } else {
    const existing = pendingByConversationId.get(event.conversationId);
    if (existing) {
      const remaining = existing.filter(
        (entry) => entry.turn.id !== event.turnId
      );
      if (remaining.length === 0) {
        pendingByConversationId.delete(event.conversationId);
      } else {
        pendingByConversationId.set(event.conversationId, remaining);
      }
    }
  }
  listeners.forEach((listener) => listener(event));
}

export function consumeBufferedOptimisticConversationTurns(
  conversationId: string
): MessageTurn[] {
  pruneExpiredBufferedTurns();
  const buffered = pendingByConversationId.get(conversationId);
  if (!buffered || buffered.length === 0) return [];
  pendingByConversationId.delete(conversationId);
  return buffered.map((entry) => entry.turn);
}

export function acknowledgeOptimisticConversationTurn(
  conversationId: string,
  turnId: string
): void {
  const existing = pendingByConversationId.get(conversationId);
  if (!existing) return;
  const remaining = existing.filter((entry) => entry.turn.id !== turnId);
  if (remaining.length === 0) {
    pendingByConversationId.delete(conversationId);
  } else {
    pendingByConversationId.set(conversationId, remaining);
  }
}

export function clearBufferedOptimisticConversationTurnsForTests(): void {
  pendingByConversationId.clear();
}

export function subscribeToOptimisticConversationTurns(
  listener: OptimisticConversationTurnListener
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}


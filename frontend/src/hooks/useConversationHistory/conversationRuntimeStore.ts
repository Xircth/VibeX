import { ExecutionProcessStatus } from 'shared/types';
import type { ExecutionProcessStateStore } from './types';

export const MAX_CONVERSATION_RUNTIME_ENTRIES = 20;

export type ConversationRuntimeState = {
  displayedExecutionProcesses: ExecutionProcessStateStore;
  processIdsKey: string;
  previousStatusMap: Array<[string, ExecutionProcessStatus]>;
};

const conversationRuntimeByKey = new Map<string, ConversationRuntimeState>();
let conversationStreamSubscriptionCounter = 0;

export function clearConversationRuntimeForTests() {
  conversationRuntimeByKey.clear();
}

export function getConversationRuntimeState(
  key: string
): ConversationRuntimeState | undefined {
  return conversationRuntimeByKey.get(key);
}

export function rememberConversationHistoryState(
  key: string | null,
  displayedExecutionProcesses: ExecutionProcessStateStore,
  processIdsKey: string,
  previousStatusMap: Map<string, ExecutionProcessStatus>,
  options: { clone: boolean }
) {
  if (!key) return;

  conversationRuntimeByKey.delete(key);
  conversationRuntimeByKey.set(key, {
    displayedExecutionProcesses: options.clone
      ? structuredClone(displayedExecutionProcesses)
      : displayedExecutionProcesses,
    processIdsKey,
    previousStatusMap: Array.from(previousStatusMap.entries()),
  });

  while (conversationRuntimeByKey.size > MAX_CONVERSATION_RUNTIME_ENTRIES) {
    const oldestKey = conversationRuntimeByKey.keys().next().value;
    if (!oldestKey) break;
    conversationRuntimeByKey.delete(oldestKey);
  }
}

export function createConversationStreamId(
  executionProcessId: string
): string {
  conversationStreamSubscriptionCounter += 1;
  return `${executionProcessId}:${Date.now()}:${conversationStreamSubscriptionCounter}`;
}

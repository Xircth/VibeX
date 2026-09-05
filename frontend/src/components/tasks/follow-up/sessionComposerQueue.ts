import type { ConversationInputView, ExecutorProfileId } from 'shared/types';
import type { SessionComposerPluginActionInvocation } from './sessionComposerStructuredTokens';

export const QUEUE_STATUS_QUERY_KEY = 'conversation-inputs';

export type QueueStatusQueryKey = readonly [
  typeof QUEUE_STATUS_QUERY_KEY,
  string | undefined,
];

export type QueuedMessage = {
  id: string;
  session_id: string;
  operationId: string;
  revision: bigint;
  sortKey: bigint;
  status: 'queued' | 'claimed';
  created_at: string;
  updated_at: string;
  executorProfileId: ExecutorProfileId;
  data: {
    message: string;
    agentMessage?: string;
    images: string[];
    pluginActions: SessionComposerPluginActionInvocation[];
  };
};

export type QueueStatus =
  | { status: 'queued'; messages: QueuedMessage[] }
  | { status: 'empty'; messages: [] };

export function getQueueStatusQueryKey(
  sessionId: string | undefined
): QueueStatusQueryKey {
  return [QUEUE_STATUS_QUERY_KEY, sessionId];
}

export function inputViewToQueuedMessage(
  input: ConversationInputView
): QueuedMessage {
  const displayText = input.payload.displayText ?? input.payload.text;
  const executorProfileId = (input.payload.executorProfileId ?? {
    executor: input.payload.agentId,
  }) as unknown as ExecutorProfileId;
  return {
    id: input.id,
    session_id: input.conversationId,
    operationId: input.operationId,
    revision: BigInt(input.revision),
    sortKey: BigInt(input.sortKey),
    status: input.status === 'claimed' ? 'claimed' : 'queued',
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    executorProfileId,
    data: {
      message: displayText,
      agentMessage:
        displayText === input.payload.text ? undefined : input.payload.text,
      images: input.payload.images ?? [],
      pluginActions: (input.payload.workflowRefs ?? []).map((reference) => ({
        pluginId: reference.pluginId,
        actionId: reference.workflowId,
      })),
    },
  };
}

export function waitingQueueMessages(
  inputs: ConversationInputView[],
  options: { excludeOperationId?: string | null } = {}
): QueuedMessage[] {
  const excludeOperationId = options.excludeOperationId ?? null;
  return inputs
    .filter((input) => input.status === 'queued')
    .filter(
      (input) =>
        excludeOperationId == null || input.operationId !== excludeOperationId
    )
    .map(inputViewToQueuedMessage);
}

export function getQueueIndicatorState(
  status: QueueStatus | undefined,
  options: { excludeOperationId?: string | null } = {}
): {
  isQueued: boolean;
  queuedMessages: QueuedMessage[];
} {
  const excludeOperationId = options.excludeOperationId ?? null;
  const queuedMessages = (status?.status === 'queued' ? status.messages : [])
    .filter((message) => message.status === 'queued')
    .filter(
      (message) =>
        excludeOperationId == null || message.operationId !== excludeOperationId
    );
  return { isQueued: queuedMessages.length > 0, queuedMessages };
}

export function getQueueSnapshot(status: QueueStatus | undefined): {
  isQueued: boolean;
  queuedMessage: QueuedMessage | null;
} {
  const messages = status?.status === 'queued' ? status.messages : [];
  return {
    isQueued: messages.length > 0,
    queuedMessage: messages.at(-1) ?? null,
  };
}

export function getAttachImageQueueSeed({
  fallbackMessage,
}: {
  fallbackMessage: string;
}): { scratchMessage: string } {
  return { scratchMessage: fallbackMessage };
}

export function getEditorChangeSideEffects({
  queueStatus,
  hasFollowUpError,
}: {
  queueStatus: QueueStatus | undefined;
  hasFollowUpError: boolean;
}): { shouldPersistDraft: boolean; shouldClearError: boolean } {
  return {
    shouldPersistDraft: queueStatus?.status !== 'queued',
    shouldClearError: hasFollowUpError,
  };
}

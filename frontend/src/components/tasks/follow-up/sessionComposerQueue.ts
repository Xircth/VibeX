import type {
  ExecutorProfileId,
  QueuedMessage,
  QueueStatus,
} from 'shared/types';

export const QUEUE_STATUS_QUERY_KEY = 'queue-status';

export type QueueStatusQueryKey = readonly [
  typeof QUEUE_STATUS_QUERY_KEY,
  string | undefined,
];

export type QueueMutationInput = {
  sessionId: string;
  message: string;
  images: string[];
  executorProfileId: ExecutorProfileId;
};

export type CancelQueueMutationInput = {
  sessionId: string;
};

export function getQueueStatusQueryKey(
  sessionId: string | undefined
): QueueStatusQueryKey {
  return [QUEUE_STATUS_QUERY_KEY, sessionId];
}

export function buildQueueMutationInput({
  sessionId,
  message,
  images,
  executorProfileId,
}: {
  sessionId: string | undefined;
  message: string;
  images: string[];
  executorProfileId: ExecutorProfileId;
}): QueueMutationInput | null {
  if (!sessionId) return null;

  return {
    sessionId,
    message,
    images,
    executorProfileId,
  };
}

export function buildCancelQueueMutationInput(
  sessionId: string | undefined
): CancelQueueMutationInput | null {
  if (!sessionId) return null;
  return { sessionId };
}

export type QueueSnapshot = {
  isQueued: boolean;
  queuedMessage: QueuedMessage | null;
};

export function getQueueSnapshot(
  status: QueueStatus | undefined
): QueueSnapshot {
  if (status?.status !== 'queued') {
    return { isQueued: false, queuedMessage: null };
  }

  return { isQueued: true, queuedMessage: status.message };
}

export function getVisibleQueuedMessage(
  status: QueueStatus | undefined,
  isAttemptRunning: boolean
): QueuedMessage | null {
  if (!isAttemptRunning) return null;
  return getQueueSnapshot(status).queuedMessage;
}

export function getQueueIndicatorState(
  status: QueueStatus | undefined,
  isAttemptRunning: boolean
): {
  isQueued: boolean;
  messagePreview: string | null;
  attachmentCount: number;
} {
  const queuedMessage = getVisibleQueuedMessage(status, isAttemptRunning);

  return {
    isQueued: Boolean(queuedMessage),
    messagePreview: queuedMessage?.data.message ?? null,
    attachmentCount: queuedMessage?.data.images.length ?? 0,
  };
}

export function getAttachImageQueueSeed({
  queueStatus,
  fallbackMessage,
}: {
  queueStatus: QueueStatus | undefined;
  fallbackMessage: string;
}): {
  shouldCancelQueue: boolean;
  scratchMessage: string;
  queuedImagePaths: string[];
} {
  const { queuedMessage } = getQueueSnapshot(queueStatus);

  if (!queuedMessage) {
    return {
      shouldCancelQueue: false,
      scratchMessage: fallbackMessage,
      queuedImagePaths: [],
    };
  }

  return {
    shouldCancelQueue: true,
    scratchMessage: queuedMessage.data.message,
    queuedImagePaths: queuedMessage.data.images,
  };
}

export function shouldRefreshQueueStatus({
  hasWorkspace,
  isAttemptRunning,
  previousProcessCount,
  currentProcessCount,
}: {
  hasWorkspace: boolean;
  isAttemptRunning: boolean;
  previousProcessCount: number;
  currentProcessCount: number;
}): boolean {
  if (!hasWorkspace) return false;
  if (!isAttemptRunning) return true;
  return currentProcessCount > previousProcessCount;
}

export function getEditorChangeSideEffects({
  queueStatus,
  hasFollowUpError,
}: {
  queueStatus: QueueStatus | undefined;
  hasFollowUpError: boolean;
}): {
  shouldCancelQueue: boolean;
  shouldClearError: boolean;
} {
  return {
    shouldCancelQueue: getQueueSnapshot(queueStatus).isQueued,
    shouldClearError: hasFollowUpError,
  };
}

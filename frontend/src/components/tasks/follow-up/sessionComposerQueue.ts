import type { ExecutorProfileId } from 'shared/types';
import type { SessionComposerPluginActionInvocation } from './sessionComposerStructuredTokens';

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
  pluginActions: SessionComposerPluginActionInvocation[];
};

export type CancelQueueMutationInput = {
  sessionId: string;
};

export type QueuedMessage = {
  id?: string;
  session_id?: string;
  sequence?: number;
  created_at?: string;
  updated_at?: string;
  executorProfileId: ExecutorProfileId;
  data: {
    message: string;
    images: string[];
    pluginActions?: SessionComposerPluginActionInvocation[];
  };
};

export type QueueStatus =
  | {
      status: 'queued';
      message: QueuedMessage;
    }
  | {
      status: 'empty';
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
  pluginActions = [],
}: {
  sessionId: string | undefined;
  message: string;
  images: string[];
  executorProfileId: ExecutorProfileId;
  pluginActions?: SessionComposerPluginActionInvocation[];
}): QueueMutationInput | null {
  if (!sessionId) return null;

  return {
    sessionId,
    message,
    images,
    executorProfileId,
    pluginActions,
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
  queuedMessage: QueuedMessage | null;
  messagePreview: string | null;
  attachmentCount: number;
} {
  const queuedMessage = getVisibleQueuedMessage(status, isAttemptRunning);

  return {
    isQueued: Boolean(queuedMessage),
    queuedMessage,
    messagePreview: queuedMessage?.data.message ?? null,
    attachmentCount: queuedMessage?.data.images.length ?? 0,
  };
}

export function getAttachImageQueueSeed({
  fallbackMessage,
}: {
  fallbackMessage: string;
}): {
  scratchMessage: string;
} {
  return {
    scratchMessage: fallbackMessage,
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
  shouldPersistDraft: boolean;
  shouldClearError: boolean;
} {
  return {
    shouldPersistDraft: !getQueueSnapshot(queueStatus).isQueued,
    shouldClearError: hasFollowUpError,
  };
}

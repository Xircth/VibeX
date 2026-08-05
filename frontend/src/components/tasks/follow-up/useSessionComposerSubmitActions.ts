import { useCallback } from 'react';
import type { ExecutorProfileId } from 'shared/types';
import {
  buildQueuedFollowUp,
  getSubmitShortcutAction,
} from './sessionComposerSubmit';
import type { SessionComposerPluginActionInvocation } from './sessionComposerStructuredTokens';

export function useSessionComposerSubmitActions({
  localMessage,
  conflictResolutionInstructions,
  reviewMarkdown,
  attachedImagePaths,
  effectiveExecutorProfile,
  isAttemptRunning,
  isQueued,
  clearStopping,
  cancelDebouncedSave,
  saveToScratch,
  queueMessage,
  onAfterQueueCleanup,
  onSendFollowUp,
}: {
  localMessage: string;
  conflictResolutionInstructions: string | null | undefined;
  reviewMarkdown: string | null | undefined;
  attachedImagePaths: string[];
  effectiveExecutorProfile: ExecutorProfileId | null;
  isAttemptRunning: boolean;
  isQueued: boolean;
  clearStopping: () => void;
  cancelDebouncedSave: () => void;
  saveToScratch: (
    message: string,
    executorProfileId: ExecutorProfileId | null
  ) => Promise<void> | void;
  queueMessage: (
    message: string,
    executorProfileId: ExecutorProfileId,
    images?: string[],
    pluginActions?: SessionComposerPluginActionInvocation[]
  ) => Promise<void> | void;
  onAfterQueueCleanup: () => void | Promise<void>;
  onSendFollowUp: () => void;
}) {
  const handleQueueMessage = useCallback(async () => {
    const queuedFollowUp = buildQueuedFollowUp({
      message: localMessage,
      conflictMarkdown: conflictResolutionInstructions,
      reviewMarkdown,
      images: attachedImagePaths,
      executorProfile: effectiveExecutorProfile,
    });
    if (!queuedFollowUp) return;

    clearStopping();
    cancelDebouncedSave();
    await saveToScratch(localMessage, effectiveExecutorProfile);
    await queueMessage(
      queuedFollowUp.message,
      queuedFollowUp.executorProfile,
      queuedFollowUp.images,
      queuedFollowUp.pluginActions
    );
    await onAfterQueueCleanup();
  }, [
    attachedImagePaths,
    cancelDebouncedSave,
    clearStopping,
    conflictResolutionInstructions,
    effectiveExecutorProfile,
    localMessage,
    onAfterQueueCleanup,
    queueMessage,
    reviewMarkdown,
    saveToScratch,
  ]);

  const handleSubmitShortcut = useCallback(
    (e?: KeyboardEvent) => {
      e?.preventDefault();
      const action = getSubmitShortcutAction({ isAttemptRunning, isQueued });
      if (action === 'queue') {
        void handleQueueMessage();
        return;
      }
      if (action === 'send') onSendFollowUp();
    },
    [handleQueueMessage, isAttemptRunning, isQueued, onSendFollowUp]
  );

  return { handleQueueMessage, handleSubmitShortcut };
}

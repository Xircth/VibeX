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
  onSubmitFollowUp,
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
    pluginActions?: SessionComposerPluginActionInvocation[],
    agentMessage?: string
  ) => Promise<void> | void;
  onAfterQueueCleanup: () => void | Promise<void>;
  onSendFollowUp: () => void;
  onSubmitFollowUp: (message: string) => void;
}) {
  const handleQueueMessage = useCallback(
    async (submittedMessage?: string) => {
      const acceptedMessage = submittedMessage ?? localMessage;
      const queuedFollowUp = buildQueuedFollowUp({
        message: acceptedMessage,
        conflictMarkdown: conflictResolutionInstructions,
        reviewMarkdown,
        images: attachedImagePaths,
        executorProfile: effectiveExecutorProfile,
      });
      if (!queuedFollowUp) return;

      clearStopping();
      cancelDebouncedSave();
      await saveToScratch(acceptedMessage, effectiveExecutorProfile);
      await queueMessage(
        queuedFollowUp.displayMessage,
        queuedFollowUp.executorProfile,
        queuedFollowUp.images,
        queuedFollowUp.pluginActions,
        queuedFollowUp.message
      );
      await onAfterQueueCleanup();
    },
    [
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
    ]
  );

  const handleSubmitShortcut = useCallback(
    (eventOrMessage?: KeyboardEvent | string) => {
      const submittedMessage =
        typeof eventOrMessage === 'string' ? eventOrMessage : undefined;
      if (eventOrMessage && typeof eventOrMessage !== 'string') {
        eventOrMessage.preventDefault();
      }
      const action = getSubmitShortcutAction({ isAttemptRunning, isQueued });
      if (action === 'queue') {
        void handleQueueMessage(submittedMessage);
        return;
      }
      if (action === 'send') {
        if (submittedMessage !== undefined) {
          onSubmitFollowUp(submittedMessage);
        } else {
          onSendFollowUp();
        }
      }
    },
    [
      handleQueueMessage,
      isAttemptRunning,
      isQueued,
      onSendFollowUp,
      onSubmitFollowUp,
    ]
  );

  return { handleQueueMessage, handleSubmitShortcut };
}

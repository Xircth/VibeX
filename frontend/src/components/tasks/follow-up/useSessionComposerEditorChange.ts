import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { QueueStatus } from 'shared/types';
import {
  buildCancelQueueMutationInput,
  getEditorChangeSideEffects,
  getQueueStatusQueryKey,
  type CancelQueueMutationInput,
} from './sessionComposerQueue';

export function useSessionComposerEditorChange({
  sessionId,
  followUpError,
  setFollowUpError,
  setLocalMessage,
  setFollowUpMessage,
  cancelQueuedMessage,
}: {
  sessionId: string | undefined;
  followUpError: string | null;
  setFollowUpError: (error: string | null) => void;
  setLocalMessage: Dispatch<SetStateAction<string>>;
  setFollowUpMessage: (message: string) => void;
  cancelQueuedMessage: (input: CancelQueueMutationInput) => void;
}) {
  const queryClient = useQueryClient();
  const setFollowUpMessageRef = useRef(setFollowUpMessage);

  useEffect(() => {
    setFollowUpMessageRef.current = setFollowUpMessage;
  }, [setFollowUpMessage]);

  const applyDraftMessage = useCallback(
    (message: string) => {
      setLocalMessage(message);
      setFollowUpMessageRef.current(message);
    },
    [setLocalMessage]
  );

  const handleEditorChange = useCallback(
    (value: string) => {
      const status = queryClient.getQueryData<QueueStatus>(
        getQueueStatusQueryKey(sessionId)
      );
      const { shouldCancelQueue, shouldClearError } =
        getEditorChangeSideEffects({
          queueStatus: status,
          hasFollowUpError: !!followUpError,
        });

      if (shouldCancelQueue) {
        const cancelInput = buildCancelQueueMutationInput(sessionId);
        if (cancelInput) cancelQueuedMessage(cancelInput);
      }

      applyDraftMessage(value);
      if (shouldClearError) setFollowUpError(null);
    },
    [
      applyDraftMessage,
      cancelQueuedMessage,
      followUpError,
      queryClient,
      sessionId,
      setFollowUpError,
    ]
  );

  return { applyDraftMessage, handleEditorChange };
}

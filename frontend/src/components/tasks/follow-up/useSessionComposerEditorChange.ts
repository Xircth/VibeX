import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getEditorChangeSideEffects,
  getQueueStatusQueryKey,
  type QueueStatus,
} from './sessionComposerQueue';

export function useSessionComposerEditorChange({
  sessionId,
  followUpError,
  setFollowUpError,
  setLocalMessage,
  setFollowUpMessage,
}: {
  sessionId: string | undefined;
  followUpError: string | null;
  setFollowUpError: (error: string | null) => void;
  setLocalMessage: Dispatch<SetStateAction<string>>;
  setFollowUpMessage: (message: string) => void;
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
      const { shouldPersistDraft, shouldClearError } =
        getEditorChangeSideEffects({
          queueStatus: status,
          hasFollowUpError: !!followUpError,
        });

      if (shouldPersistDraft) {
        applyDraftMessage(value);
      } else {
        setLocalMessage(value);
      }
      if (shouldClearError) setFollowUpError(null);
    },
    [
      applyDraftMessage,
      followUpError,
      queryClient,
      sessionId,
      setLocalMessage,
      setFollowUpError,
    ]
  );

  return { applyDraftMessage, handleEditorChange };
}

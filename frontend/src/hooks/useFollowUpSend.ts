import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '@/lib/api';
import type { CreateFollowUpAttempt, ExecutorProfileId } from 'shared/types';
import { buildAgentPrompt } from '@/utils/promptMessage';

type Args = {
  sessionId?: string;
  sessionExecutor?: string | null;
  workspaceId?: string;
  isNewSessionMode?: boolean;
  newSessionName?: string;
  onSelectSession?: (sessionId: string) => void;
  onSessionCreated?: (session: {
    sessionId: string;
    workspaceId: string;
  }) => void;
  message: string;
  conflictMarkdown: string | null;
  reviewMarkdown: string;
  executorProfileId: ExecutorProfileId | null;
  clearComments: () => void;
  onAfterSendCleanup: () => void | Promise<void>;
};

export function useFollowUpSend({
  sessionId,
  sessionExecutor,
  workspaceId,
  isNewSessionMode,
  newSessionName,
  onSelectSession,
  onSessionCreated,
  message,
  conflictMarkdown,
  reviewMarkdown,
  executorProfileId,
  clearComments,
  onAfterSendCleanup,
}: Args) {
  const queryClient = useQueryClient();
  const [isSendingFollowUp, setIsSendingFollowUp] = useState(false);
  const [followUpError, setFollowUpError] = useState<string | null>(null);

  const onSendFollowUp = useCallback(async () => {
    if (!executorProfileId) return;

    const extraMessage = message.trim();
    const { prompt, isSlashCommand } = buildAgentPrompt(extraMessage, [
      conflictMarkdown,
      reviewMarkdown?.trim(),
    ]);

    if (!prompt) return;

    try {
      setIsSendingFollowUp(true);
      setFollowUpError(null);

      let targetSessionId = sessionId;
      const shouldCreateNewSession =
        isNewSessionMode ||
        !targetSessionId ||
        (!!sessionExecutor && sessionExecutor !== executorProfileId.executor);

      if (shouldCreateNewSession) {
        if (!workspaceId) return;

        const session = await sessionsApi.create({
          workspace_id: workspaceId,
          executor: executorProfileId.executor,
          name: newSessionName?.trim() ? newSessionName.trim() : null,
        });

        targetSessionId = session.id;
        onSelectSession?.(session.id);
        onSessionCreated?.({
          sessionId: session.id,
          workspaceId: session.workspace_id,
        });

        queryClient.invalidateQueries({
          queryKey: ['workspaceSessions', workspaceId],
        });
      }

      const body: CreateFollowUpAttempt = {
        prompt,
        executor_profile_id: executorProfileId,
        retry_process_id: null,
        force_when_dirty: null,
        perform_git_reset: null,
      };
      if (!targetSessionId) {
        throw new Error('No target session available for follow-up');
      }
      await sessionsApi.followUp(targetSessionId, body);
      if (!isSlashCommand) {
        clearComments();
      }
      await onAfterSendCleanup();
    } catch (error: unknown) {
      const err = error as { message?: string };
      setFollowUpError(
        `Failed to start follow-up execution: ${err.message ?? 'Unknown error'}`
      );
    } finally {
      setIsSendingFollowUp(false);
    }
  }, [
    queryClient,
    sessionId,
    sessionExecutor,
    workspaceId,
    isNewSessionMode,
    newSessionName,
    onSelectSession,
    onSessionCreated,
    message,
    conflictMarkdown,
    reviewMarkdown,
    executorProfileId,
    clearComments,
    onAfterSendCleanup,
  ]);

  return {
    isSendingFollowUp,
    followUpError,
    setFollowUpError,
    onSendFollowUp,
  } as const;
}

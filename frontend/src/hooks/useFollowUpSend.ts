import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '@/lib/api';
import type { CreateFollowUpAttempt, ExecutorProfileId } from 'shared/types';
import { buildAgentPrompt } from '@/utils/promptMessage';

type Args = {
  sessionId?: string;
  workspaceId?: string;
  isNewSessionMode?: boolean;
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
  workspaceId,
  isNewSessionMode,
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
      if (isNewSessionMode || !targetSessionId) {
        if (!workspaceId) return;

        const session = await sessionsApi.create({
          workspace_id: workspaceId,
          executor: executorProfileId.executor,
        });

        targetSessionId = session.id;
        onSelectSession?.(session.id);
        onSessionCreated?.({
          sessionId: session.id,
          workspaceId: session.workspace_id,
        });

        // Immediately invalidate session cache so useWorkspaceSessions
        // picks up the new session and ExecutionProcessesProvider can
        // subscribe to the conversation stream without delay.
        queryClient.invalidateQueries({
          queryKey: ['workspaceSessions', workspaceId],
        });
      }

      const body: CreateFollowUpAttempt = {
        prompt: prompt,
        executor_profile_id: executorProfileId,
        retry_process_id: null,
        force_when_dirty: null,
        perform_git_reset: null,
      };
      await sessionsApi.followUp(targetSessionId, body);
      if (!isSlashCommand) {
        clearComments();
      }
      await onAfterSendCleanup();
      // Don't call jumpToLogsTab() - preserves focus on the follow-up editor
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
    workspaceId,
    isNewSessionMode,
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

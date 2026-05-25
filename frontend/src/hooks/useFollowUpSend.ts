import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { sessionsApi } from '@/lib/api';
import type { ExecutorProfileId } from 'shared/types';
import { sendProviderRuntimeTurn } from '@/features/provider-runtime/sendProviderRuntimeTurn';
import {
  buildAgentPrompt,
  isSessionScopedSlashCommand,
} from '@/utils/promptMessage';

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
  images?: string[];
  conflictMarkdown: string | null;
  reviewMarkdown: string;
  executorProfileId: ExecutorProfileId | null;
  clearComments: () => void;
  onBeforeSend?: () => void;
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
  images = [],
  conflictMarkdown,
  reviewMarkdown,
  executorProfileId,
  clearComments,
  onBeforeSend,
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

    if (!prompt && images.length === 0) return;

    try {
      onBeforeSend?.();
      setIsSendingFollowUp(true);
      setFollowUpError(null);

      let targetSessionId = sessionId;
      let targetWorkspaceId = workspaceId;
      const shouldCreateNewSession =
        isNewSessionMode ||
        !targetSessionId ||
        (!!sessionExecutor && sessionExecutor !== executorProfileId.executor);

      if (shouldCreateNewSession && isSessionScopedSlashCommand(prompt)) {
        throw new Error('该 / 命令需要在已有会话中执行，不能创建新会话触发。');
      }

      if (shouldCreateNewSession) {
        if (!workspaceId) return;

        const session = await sessionsApi.create({
          workspace_id: workspaceId,
          executor: executorProfileId.executor,
          name: newSessionName?.trim() ? newSessionName.trim() : null,
          initial_prompt: prompt,
        });

        targetSessionId = session.id;
        targetWorkspaceId = session.workspace_id;
        onSelectSession?.(session.id);
        onSessionCreated?.({
          sessionId: session.id,
          workspaceId: session.workspace_id,
        });

        queryClient.invalidateQueries({
          queryKey: ['workspaceSessions', workspaceId],
        });
      }

      if (!targetSessionId) {
        throw new Error('No target session available for follow-up');
      }
      if (!targetWorkspaceId) {
        throw new Error('No workspace available for provider runtime turn');
      }
      await sendProviderRuntimeTurn({
        workspaceId: targetWorkspaceId,
        sessionId: targetSessionId,
        executorProfileId,
        text: prompt,
        images,
      });
      if (!isSlashCommand) {
        clearComments();
      }
      await onAfterSendCleanup();
    } catch (error: unknown) {
      const err = error as { message?: string };
      setFollowUpError(`启动后续执行失败：${err.message ?? '未知错误'}`);
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
    images,
    conflictMarkdown,
    reviewMarkdown,
    executorProfileId,
    clearComments,
    onBeforeSend,
    onAfterSendCleanup,
  ]);

  return {
    isSendingFollowUp,
    followUpError,
    setFollowUpError,
    onSendFollowUp,
  } as const;
}
